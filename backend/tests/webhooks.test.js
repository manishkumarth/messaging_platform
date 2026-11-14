import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, createMessage, sendEvent, SECRET } from './helpers.js';

const getMessage = async (api, id) =>
  (await api.get(`/api/v1/messages/${id}`).set('x-tenant-id', 'tenant-a')).body.data;
const eventCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM message_events').get().n;

test('webhook applies DELIVERED and records the timestamp', async () => {
  const { api, db } = makeTestApp();
  const m = await createMessage(api);

  const res = await sendEvent(api, m.id, 'DELIVERED', '2026-10-16T08:30:00.000Z', 'evt-001');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, {
    eventId: 'evt-001',
    messageId: m.id,
    duplicate: false,
    outcome: 'APPLIED',
    messageStatus: 'DELIVERED',
  });

  const after = await getMessage(api, m.id);
  assert.equal(after.status, 'DELIVERED');
  assert.equal(after.timestamps.deliveredAt, '2026-10-16T08:30:00.000Z');
  assert.equal(eventCount(db), 1);
});

test('a full happy path QUEUED -> SENT -> DELIVERED -> READ', async () => {
  const { api } = makeTestApp();
  const m = await createMessage(api);
  for (const [status, at] of [
    ['SENT', '2026-10-16T08:00:00.000Z'],
    ['DELIVERED', '2026-10-16T08:01:00.000Z'],
    ['READ', '2026-10-16T08:02:00.000Z'],
  ]) {
    const res = await sendEvent(api, m.id, status, at);
    assert.equal(res.body.data.outcome, 'APPLIED');
  }
  const final = await getMessage(api, m.id);
  assert.equal(final.status, 'READ');
  assert.deepEqual(final.timestamps, {
    sentAt: '2026-10-16T08:00:00.000Z',
    deliveredAt: '2026-10-16T08:01:00.000Z',
    readAt: '2026-10-16T08:02:00.000Z',
    failedAt: null,
  });
});

test('duplicate eventId is acknowledged but creates no second record or effect', async () => {
  const { api, db } = makeTestApp();
  const m = await createMessage(api);

  const first = await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z', 'evt-dup');
  const versionAfterFirst = db.prepare('SELECT version FROM messages WHERE id = ?').get(m.id).version;
  const second = await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z', 'evt-dup');

  assert.equal(first.status, 200);
  assert.equal(first.body.data.duplicate, false);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.duplicate, true);
  assert.equal(second.body.data.outcome, 'APPLIED'); // original outcome is replayed

  assert.equal(eventCount(db), 1);
  assert.equal(db.prepare('SELECT version FROM messages WHERE id = ?').get(m.id).version, versionAfterFirst);
});

test('a duplicate replayed after the message moved on does not revert it', async () => {
  const { api } = makeTestApp();
  const m = await createMessage(api);
  await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z', 'evt-a');
  await sendEvent(api, m.id, 'READ', '2026-10-16T08:05:00.000Z', 'evt-b');

  const replay = await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z', 'evt-a');
  assert.equal(replay.body.data.duplicate, true);
  assert.equal((await getMessage(api, m.id)).status, 'READ');
});

test('concurrent deliveries of the same eventId apply exactly once', async () => {
  const { api, db } = makeTestApp();
  const m = await createMessage(api);

  const results = await Promise.all(
    Array.from({ length: 10 }, () => sendEvent(api, m.id, 'DELIVERED', '2026-10-16T08:30:00.000Z', 'evt-race')),
  );

  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results.filter((r) => r.body.data.duplicate === false).length, 1);
  assert.equal(eventCount(db), 1);
  assert.equal(db.prepare('SELECT version FROM messages WHERE id = ?').get(m.id).version, 1);
});

test('same eventId with a different payload is a 409 conflict', async () => {
  const { api } = makeTestApp();
  const m = await createMessage(api);
  await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z', 'evt-conflict');

  const res = await sendEvent(api, m.id, 'READ', '2026-10-16T08:00:00.000Z', 'evt-conflict');
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'EVENT_ID_CONFLICT');
});

test('out-of-order: a late SENT cannot move a READ message backwards, but backfills sentAt', async () => {
  const { api } = makeTestApp();
  const m = await createMessage(api);

  await sendEvent(api, m.id, 'READ', '2026-10-16T08:10:00.000Z');
  const late = await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z');

  assert.equal(late.status, 200);
  assert.equal(late.body.data.outcome, 'IGNORED_STALE');
  assert.equal(late.body.data.messageStatus, 'READ');

  const after = await getMessage(api, m.id);
  assert.equal(after.status, 'READ');
  assert.equal(after.timestamps.sentAt, '2026-10-16T08:00:00.000Z');
  assert.equal(after.timestamps.readAt, '2026-10-16T08:10:00.000Z');
});

test('a late event never overwrites a timestamp that is already set', async () => {
  const { api } = makeTestApp();
  const m = await createMessage(api);
  await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z');
  await sendEvent(api, m.id, 'READ', '2026-10-16T08:10:00.000Z');
  await sendEvent(api, m.id, 'SENT', '2026-10-16T09:59:00.000Z'); // different eventId, same stage

  assert.equal((await getMessage(api, m.id)).timestamps.sentAt, '2026-10-16T08:00:00.000Z');
});

test('FAILED after DELIVERED is rejected by the state machine; FAILED is terminal', async () => {
  const { api } = makeTestApp();
  const delivered = await createMessage(api);
  await sendEvent(api, delivered.id, 'DELIVERED', '2026-10-16T08:00:00.000Z');
  const bad = await sendEvent(api, delivered.id, 'FAILED', '2026-10-16T08:01:00.000Z');
  assert.equal(bad.body.data.outcome, 'IGNORED_INVALID_TRANSITION');
  assert.equal((await getMessage(api, delivered.id)).status, 'DELIVERED');
  assert.equal((await getMessage(api, delivered.id)).timestamps.failedAt, null);

  const failed = await createMessage(api);
  const ok = await sendEvent(api, failed.id, 'FAILED', '2026-10-16T08:00:00.000Z');
  assert.equal(ok.body.data.outcome, 'APPLIED');
  const revive = await sendEvent(api, failed.id, 'DELIVERED', '2026-10-16T08:02:00.000Z');
  assert.equal(revive.body.data.outcome, 'IGNORED_INVALID_TRANSITION');
  assert.equal((await getMessage(api, failed.id)).status, 'FAILED');
});

test('ignored events are still persisted in the ledger for audit', async () => {
  const { api, db } = makeTestApp();
  const m = await createMessage(api);
  await sendEvent(api, m.id, 'READ', '2026-10-16T08:10:00.000Z', 'evt-r');
  await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z', 'evt-s');

  const rows = db.prepare('SELECT event_id, outcome, status_before, status_after FROM message_events ORDER BY received_at, rowid').all();
  assert.deepEqual(rows, [
    { event_id: 'evt-r', outcome: 'APPLIED', status_before: 'QUEUED', status_after: 'READ' },
    { event_id: 'evt-s', outcome: 'IGNORED_STALE', status_before: 'READ', status_after: 'READ' },
  ]);
});

test('unknown messageId is a clear 404 and nothing is stored', async () => {
  const { api, db } = makeTestApp();
  const res = await sendEvent(api, 'msg_unknown', 'SENT', '2026-10-16T08:00:00.000Z', 'evt-x');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'MESSAGE_NOT_FOUND');
  assert.equal(eventCount(db), 0);
});

test('invalid webhook payloads return 400 with field details', async () => {
  const { api } = makeTestApp();
  const m = await createMessage(api);
  const post = (body) => api.post('/api/v1/webhooks/provider').set('x-webhook-secret', SECRET).send(body);

  const empty = await post({});
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.body.error.details.map((d) => d.field).sort(), ['eventId', 'messageId', 'occurredAt', 'status']);

  const base = { eventId: 'e1', messageId: m.id, status: 'SENT', occurredAt: '2026-10-16T08:00:00.000Z' };
  assert.equal((await post({ ...base, status: 'QUEUED' })).status, 400);
  assert.equal((await post({ ...base, status: 'bogus' })).status, 400);
  assert.equal((await post({ ...base, occurredAt: 'yesterday' })).status, 400);
  assert.equal((await post({ ...base, occurredAt: '2026-10-16' })).status, 400);
  assert.equal((await post({ ...base, eventId: 123 })).status, 400);
  assert.equal((await post([])).status, 400);
});

test('webhook requires the shared secret', async () => {
  const { api } = makeTestApp();
  const m = await createMessage(api);
  const body = { eventId: 'e1', messageId: m.id, status: 'SENT', occurredAt: '2026-10-16T08:00:00.000Z' };

  const none = await api.post('/api/v1/webhooks/provider').send(body);
  assert.equal(none.status, 401);
  const wrong = await api.post('/api/v1/webhooks/provider').set('x-webhook-secret', 'nope').send(body);
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'INVALID_WEBHOOK_SECRET');
});

test('metrics count webhook outcomes and label error responses with the full route', async () => {
  const { api, metrics } = makeTestApp();
  const m = await createMessage(api);
  await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z', 'evt-m1');
  await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z', 'evt-m1');
  await sendEvent(api, 'msg_unknown', 'SENT', '2026-10-16T08:00:00.000Z');

  const find = (name, labels) =>
    metrics.snapshot().find((c) => c.name === name && Object.entries(labels).every(([k, v]) => c.labels[k] === v));

  assert.equal(find('webhook_events_total', { outcome: 'APPLIED' }).value, 1);
  assert.equal(find('webhook_events_total', { outcome: 'DUPLICATE' }).value, 1);
  assert.equal(find('http_requests_total', { route: '/api/v1/webhooks/provider', status: 404 }).value, 1);
});

test('logs never contain message text, phone numbers or the webhook secret', async () => {
  const lines = [];
  const { api } = makeTestApp({ logWrite: (l) => lines.push(l) });
  const m = await createMessage(api, { text: 'super-private-body' });
  await sendEvent(api, m.id, 'SENT', '2026-10-16T08:00:00.000Z');
  await api.post('/api/v1/webhooks/provider').set('x-webhook-secret', 'wrong-guess').send({});

  const all = lines.join('\n');
  assert.ok(all.includes('webhook event processed'));
  assert.ok(!all.includes('super-private-body'));
  assert.ok(!all.includes('+919876543210'));
  assert.ok(!all.includes(SECRET));
  assert.ok(!all.includes('wrong-guess'));
});
