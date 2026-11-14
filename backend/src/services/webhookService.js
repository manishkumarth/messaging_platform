import { AppError } from '../errors.js';
import { decide, DECISION } from '../statusMachine.js';

// Whitelisted column per status (never derived from user input).
const TIMESTAMP_COLUMN = {
  SENT: 'sent_at',
  DELIVERED: 'delivered_at',
  READ: 'read_at',
  FAILED: 'failed_at',
};

export function createWebhookService(db, { logger, metrics }) {
  const getEvent = db.prepare('SELECT * FROM message_events WHERE event_id = ?');
  const getMessage = db.prepare('SELECT * FROM messages WHERE id = ?');
  const insertEvent = db.prepare(`
    INSERT INTO message_events
      (event_id, message_id, tenant_id, status, occurred_at, received_at, outcome, status_before, status_after)
    VALUES
      (@eventId, @messageId, @tenantId, @status, @occurredAt, @receivedAt, @outcome, @before, @after)
  `);

  // Optimistic concurrency: the UPDATE only succeeds if `version` is what we read.
  const applyStatement = Object.fromEntries(
    Object.entries(TIMESTAMP_COLUMN).map(([status, col]) => [
      status,
      db.prepare(`
        UPDATE messages
        SET status = @status, version = version + 1, updated_at = @now,
            ${col} = COALESCE(${col}, @occurredAt)
        WHERE id = @id AND version = @version
      `),
    ]),
  );

  // A late SENT/DELIVERED/READ that cannot move the status still tells us *when* that
  // stage happened, so we fill the timestamp if it is empty. Status is untouched.
  const backfillStatement = Object.fromEntries(
    ['SENT', 'DELIVERED', 'READ'].map((status) => {
      const col = TIMESTAMP_COLUMN[status];
      return [
        status,
        db.prepare(`
          UPDATE messages SET ${col} = @occurredAt, updated_at = @now
          WHERE id = @id AND ${col} IS NULL
        `),
      ];
    }),
  );

  /**
   * Event ledger insert + message update happen in ONE transaction. BEGIN IMMEDIATE takes
   * the write lock up front, so two deliveries of the same event (or two different events
   * for one message) are serialised and cannot interleave their read-decide-write steps.
   * The HTTP 200 is only sent after COMMIT, i.e. after the event is durably persisted.
   */
  const processTx = db.transaction((evt) => {
    const existing = getEvent.get(evt.eventId);
    if (existing) {
      const sameEvent =
        existing.message_id === evt.messageId &&
        existing.status === evt.status &&
        existing.occurred_at === evt.occurredAt;
      if (!sameEvent) {
        throw new AppError(
          409,
          'EVENT_ID_CONFLICT',
          'eventId was already used for a different event payload',
        );
      }
      const message = getMessage.get(existing.message_id);
      return { duplicate: true, outcome: existing.outcome, messageStatus: message.status };
    }

    const message = getMessage.get(evt.messageId);
    if (!message) {
      throw new AppError(404, 'MESSAGE_NOT_FOUND', 'No message exists with that messageId');
    }

    const now = new Date().toISOString();
    const outcome = decide(message.status, evt.status);
    let statusAfter = message.status;

    if (outcome === DECISION.APPLY) {
      const result = applyStatement[evt.status].run({
        status: evt.status,
        now,
        occurredAt: evt.occurredAt,
        id: message.id,
        version: message.version,
      });
      if (result.changes !== 1) {
        throw new AppError(409, 'CONCURRENT_UPDATE', 'Message was modified concurrently, retry the event');
      }
      statusAfter = evt.status;
    } else if (outcome === DECISION.STALE && backfillStatement[evt.status]) {
      backfillStatement[evt.status].run({ occurredAt: evt.occurredAt, now, id: message.id });
    }

    insertEvent.run({
      eventId: evt.eventId,
      messageId: message.id,
      tenantId: message.tenant_id,
      status: evt.status,
      occurredAt: evt.occurredAt,
      receivedAt: now,
      outcome,
      before: message.status,
      after: statusAfter,
    });

    return { duplicate: false, outcome, messageStatus: statusAfter, tenantId: message.tenant_id };
  });

  return {
    process(evt, ctx = {}) {
      const result = processTx.immediate(evt);
      const outcomeLabel = result.duplicate ? 'DUPLICATE' : result.outcome;
      metrics?.inc('webhook_events_total', { outcome: outcomeLabel });
      logger?.info('webhook event processed', {
        requestId: ctx.requestId,
        eventId: evt.eventId,
        messageId: evt.messageId,
        tenantId: result.tenantId,
        eventStatus: evt.status,
        outcome: outcomeLabel,
        messageStatus: result.messageStatus,
      });
      return {
        eventId: evt.eventId,
        messageId: evt.messageId,
        duplicate: result.duplicate,
        outcome: result.outcome,
        messageStatus: result.messageStatus,
      };
    },
  };
}
