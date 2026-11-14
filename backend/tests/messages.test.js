import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, validMessage, createMessage } from './helpers.js';

test('POST /messages creates a QUEUED message and GET returns it', async () => {
  const { api } = makeTestApp();
  const res = await api.post('/api/v1/messages').set('x-tenant-id', 'tenant-a').send(validMessage());

  assert.equal(res.status, 201);
  const m = res.body.data;
  assert.match(m.id, /^msg_[0-9a-f-]{36}$/);
  assert.equal(m.status, 'QUEUED');
  assert.equal(m.tenantId, 'tenant-a');
  assert.equal(m.conversationId, 'conv-100');
  assert.equal(m.to, '+919876543210');
  assert.equal(m.timestamps.sentAt, null);

  const got = await api.get(`/api/v1/messages/${m.id}`).set('x-tenant-id', 'tenant-a');
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.data, m);
});

test('POST /messages reports every invalid field with a 400', async () => {
  const { api } = makeTestApp();
  const res = await api.post('/api/v1/messages').set('x-tenant-id', 'tenant-a').send({ tenantId: 'tenant-a' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  const fields = res.body.error.details.map((d) => d.field).sort();
  assert.deepEqual(fields, ['conversationId', 'text', 'to']);
  assert.ok(res.body.error.requestId);
});

test('POST /messages rejects bad phone numbers, empty and oversized text', async () => {
  const { api } = makeTestApp();
  const post = (body) => api.post('/api/v1/messages').set('x-tenant-id', 'tenant-a').send(validMessage(body));

  assert.equal((await post({ to: '9876543210' })).status, 400);
  assert.equal((await post({ to: '+0123' })).status, 400);
  assert.equal((await post({ text: '   ' })).status, 400);
  assert.equal((await post({ text: 'x'.repeat(4097) })).status, 400);
  assert.equal((await post({ text: 42 })).status, 400);
  assert.equal((await post({ conversationId: 'has spaces' })).status, 400);
  assert.equal((await post({ text: 'x'.repeat(4096) })).status, 201);
});

test('malformed JSON returns 400 INVALID_JSON, not 500', async () => {
  const { api } = makeTestApp();
  const res = await api
    .post('/api/v1/messages')
    .set('x-tenant-id', 'tenant-a')
    .set('content-type', 'application/json')
    .send('{"tenantId": ');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_JSON');
});

test('missing x-tenant-id is 401 and a body tenant mismatch is 403', async () => {
  const { api } = makeTestApp();
  const noHeader = await api.post('/api/v1/messages').send(validMessage());
  assert.equal(noHeader.status, 401);

  const mismatch = await api.post('/api/v1/messages').set('x-tenant-id', 'tenant-b').send(validMessage());
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.error.code, 'TENANT_MISMATCH');
});

test("another tenant cannot read a message by id (404, same as missing)", async () => {
  const { api } = makeTestApp();
  const m = await createMessage(api);

  const other = await api.get(`/api/v1/messages/${m.id}`).set('x-tenant-id', 'tenant-b');
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, 'MESSAGE_NOT_FOUND');

  const missing = await api.get('/api/v1/messages/msg_does-not-exist').set('x-tenant-id', 'tenant-a');
  assert.equal(missing.status, 404);
});

test('conversation history is chronological, paginated with no gaps or repeats', async () => {
  const { api } = makeTestApp();
  const created = [];
  for (let i = 0; i < 5; i += 1) created.push(await createMessage(api, { text: `msg ${i}` }));

  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const url = `/api/v1/conversations/conv-100/messages?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await api.get(url).set('x-tenant-id', 'tenant-a');
    assert.equal(res.status, 200);
    seen.push(...res.body.data.map((m) => m.id));
    cursor = res.body.pagination.nextCursor;
    pages += 1;
    assert.equal(res.body.pagination.hasMore, cursor !== null);
  } while (cursor);

  assert.equal(pages, 3);
  assert.deepEqual(seen, created.map((m) => m.id));
});

test('a message created mid-pagination appears at the end and does not shift earlier pages', async () => {
  const { api } = makeTestApp();
  const first = await createMessage(api, { text: 'one' });
  const second = await createMessage(api, { text: 'two' });

  const page1 = await api.get('/api/v1/conversations/conv-100/messages?limit=1').set('x-tenant-id', 'tenant-a');
  assert.deepEqual(page1.body.data.map((m) => m.id), [first.id]);

  const late = await createMessage(api, { text: 'late arrival' });

  const page2 = await api
    .get(`/api/v1/conversations/conv-100/messages?limit=5&cursor=${page1.body.pagination.nextCursor}`)
    .set('x-tenant-id', 'tenant-a');
  assert.deepEqual(page2.body.data.map((m) => m.id), [second.id, late.id]);
});

test('conversation listing is tenant isolated, even for the same conversation id', async () => {
  const { api } = makeTestApp();
  const a = await createMessage(api, {}, 'tenant-a');
  const b = await createMessage(api, { tenantId: 'tenant-b' }, 'tenant-b');

  const listA = await api.get('/api/v1/conversations/conv-100/messages').set('x-tenant-id', 'tenant-a');
  const listB = await api.get('/api/v1/conversations/conv-100/messages').set('x-tenant-id', 'tenant-b');
  const listC = await api.get('/api/v1/conversations/conv-100/messages').set('x-tenant-id', 'tenant-c');

  assert.deepEqual(listA.body.data.map((m) => m.id), [a.id]);
  assert.deepEqual(listB.body.data.map((m) => m.id), [b.id]);
  assert.deepEqual(listC.body.data, []);
});

test('a cursor from one tenant cannot be used to read another tenant\'s messages', async () => {
  const { api } = makeTestApp();
  await createMessage(api, {}, 'tenant-a');
  await createMessage(api, {}, 'tenant-a');
  const secretB = await createMessage(api, { tenantId: 'tenant-b' }, 'tenant-b');

  const pageA = await api.get('/api/v1/conversations/conv-100/messages?limit=1').set('x-tenant-id', 'tenant-a');
  const stolen = await api
    .get(`/api/v1/conversations/conv-100/messages?cursor=${pageA.body.pagination.nextCursor}`)
    .set('x-tenant-id', 'tenant-a');
  assert.ok(!stolen.body.data.some((m) => m.id === secretB.id));
});

test('invalid limit and cursor are 400s', async () => {
  const { api } = makeTestApp();
  const get = (qs) => api.get(`/api/v1/conversations/conv-100/messages${qs}`).set('x-tenant-id', 'tenant-a');

  assert.equal((await get('?limit=0')).status, 400);
  assert.equal((await get('?limit=101')).status, 400);
  assert.equal((await get('?limit=abc')).status, 400);
  assert.equal((await get('?cursor=not-a-cursor!!')).status, 400);
  assert.equal((await get('?limit=100')).status, 200);
});

test('unknown routes return a JSON 404', async () => {
  const { api } = makeTestApp();
  const res = await api.get('/api/v1/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND');
});
