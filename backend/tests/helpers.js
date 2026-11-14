import request from 'supertest';
import { openDatabase } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/metrics.js';

export const SECRET = 'test-secret';

export function makeTestApp({ dbFile = ':memory:', webhookSecret = SECRET, logWrite } = {}) {
  const db = openDatabase(dbFile);
  const config = { webhookSecret, maxTextLength: 4096 };
  const logger = createLogger({ level: logWrite ? 'debug' : 'silent', write: logWrite });
  const metrics = createMetrics();
  const app = createApp({ db, config, logger, metrics });
  return { app, db, metrics, api: request(app) };
}

export const validMessage = (overrides = {}) => ({
  tenantId: 'tenant-a',
  conversationId: 'conv-100',
  to: '+919876543210',
  text: 'Your order has shipped',
  ...overrides,
});

export async function createMessage(api, overrides = {}, tenant = 'tenant-a') {
  const res = await api.post('/api/v1/messages').set('x-tenant-id', tenant).send(validMessage(overrides));
  if (res.status !== 201) throw new Error(`createMessage failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

let counter = 0;
export function sendEvent(api, messageId, status, occurredAt, eventId) {
  counter += 1;
  return api
    .post('/api/v1/webhooks/provider')
    .set('x-webhook-secret', SECRET)
    .send({
      eventId: eventId ?? `evt-${counter}-${Math.random().toString(36).slice(2, 8)}`,
      messageId,
      status,
      occurredAt: occurredAt ?? new Date().toISOString(),
    });
}
