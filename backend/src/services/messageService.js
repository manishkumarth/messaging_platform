import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';

export function toMessageDto(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    to: row.recipient,
    text: row.body,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    timestamps: {
      sentAt: row.sent_at,
      deliveredAt: row.delivered_at,
      readAt: row.read_at,
      failedAt: row.failed_at,
    },
  };
}

// Cursor = opaque base64url of the last seen `seq`. It carries no tenant/conversation
// information; isolation comes from the WHERE clause, so a cursor can never widen access.
export const encodeCursor = (seq) => Buffer.from(String(seq), 'utf8').toString('base64url');

export function decodeCursor(cursor) {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d{1,15}$/.test(decoded) || encodeCursor(decoded) !== cursor) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
      { field: 'cursor', message: 'is not a valid cursor' },
    ]);
  }
  return Number.parseInt(decoded, 10);
}

export function createMessageService(db) {
  const insert = db.prepare(`
    INSERT INTO messages (id, tenant_id, conversation_id, recipient, body, status, version, created_at, updated_at)
    VALUES (@id, @tenantId, @conversationId, @to, @text, 'QUEUED', 0, @now, @now)
  `);
  const byIdForTenant = db.prepare('SELECT * FROM messages WHERE id = ? AND tenant_id = ?');
  const page = db.prepare(`
    SELECT * FROM messages
    WHERE tenant_id = ? AND conversation_id = ? AND seq > ?
    ORDER BY seq ASC
    LIMIT ?
  `);

  return {
    create({ tenantId, conversationId, to, text }) {
      const id = `msg_${randomUUID()}`;
      const now = new Date().toISOString();
      insert.run({ id, tenantId, conversationId, to, text, now });
      return toMessageDto(byIdForTenant.get(id, tenantId));
    },

    /** Tenant-scoped lookup. Another tenant's message is indistinguishable from a missing one. */
    getForTenant(messageId, tenantId) {
      const row = byIdForTenant.get(messageId, tenantId);
      if (!row) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Message not found');
      return toMessageDto(row);
    },

    listConversation({ tenantId, conversationId, limit, cursor }) {
      const after = cursor ? decodeCursor(cursor) : 0;
      // Fetch one extra row to learn whether another page exists without a COUNT query.
      const rows = page.all(tenantId, conversationId, after, limit + 1);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeCursor(items[items.length - 1].seq) : null;
      return { items: items.map(toMessageDto), limit, hasMore, nextCursor };
    },
  };
}
