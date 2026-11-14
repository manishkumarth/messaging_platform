import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestApp, createMessage, sendEvent } from './helpers.js';
import { openDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';

test('data survives a restart (new app + new connection on the same file)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-api-'));
  const dbFile = path.join(dir, 'app.db');
  try {
    const first = makeTestApp({ dbFile });
    const m = await createMessage(first.api);
    await sendEvent(first.api, m.id, 'DELIVERED', '2026-10-16T08:30:00.000Z', 'evt-persist');
    first.db.close(); // "server stops"

    const second = makeTestApp({ dbFile }); // "server starts again"
    const got = await second.api.get(`/api/v1/messages/${m.id}`).set('x-tenant-id', 'tenant-a');
    assert.equal(got.status, 200);
    assert.equal(got.body.data.status, 'DELIVERED');

    // Idempotency also survives the restart: the event ledger is durable.
    const replay = await sendEvent(second.api, m.id, 'DELIVERED', '2026-10-16T08:30:00.000Z', 'evt-persist');
    assert.equal(replay.body.data.duplicate, true);
    second.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations are idempotent: a second run applies nothing', () => {
  const db = openDatabase(':memory:'); // already migrated on open
  assert.deepEqual(runMigrations(db), []);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(tables.includes('messages'));
  assert.ok(tables.includes('message_events'));
  assert.ok(tables.includes('schema_migrations'));
});

test('GET /health reports database up, and 503 when the database is unavailable', async () => {
  const { api, db } = makeTestApp();
  const ok = await api.get('/health');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'ok');
  assert.equal(ok.body.checks.database, 'up');
  assert.ok(!JSON.stringify(ok.body).includes('.db'));

  db.close();
  const down = await api.get('/health');
  assert.equal(down.status, 503);
  assert.equal(down.body.checks.database, 'down');
});
