import { Router } from 'express';
import { AppError } from '../errors.js';
import { requireTenant } from '../middleware/tenant.js';
import {
  parseLimit,
  validateConversationId,
  validateCreateMessage,
  validateMessageId,
} from '../validation.js';

export function messagesRouter({ messageService, config, logger, metrics }) {
  const router = Router();
  router.use(requireTenant);

  // POST /api/v1/messages
  router.post('/', (req, res) => {
    const input = validateCreateMessage(req.body, { maxTextLength: config.maxTextLength });

    // Tenant comes from the (assumed) authenticated header; the body may not override it.
    if (input.tenantId !== req.tenantId) {
      throw new AppError(403, 'TENANT_MISMATCH', 'tenantId in body does not match the authenticated tenant');
    }

    const message = messageService.create(input);
    metrics.inc('messages_created_total');
    logger.info('message queued', {
      requestId: req.id,
      messageId: message.id,
      tenantId: message.tenantId,
      conversationId: message.conversationId,
    });
    res.status(201).json({ data: message });
  });

  // GET /api/v1/messages/:messageId
  router.get('/:messageId', (req, res) => {
    const messageId = validateMessageId(req.params.messageId);
    res.json({ data: messageService.getForTenant(messageId, req.tenantId) });
  });

  return router;
}

export function conversationsRouter({ messageService }) {
  const router = Router();
  router.use(requireTenant);

  // GET /api/v1/conversations/:conversationId/messages?limit=20&cursor=...
  router.get('/:conversationId/messages', (req, res) => {
    const conversationId = validateConversationId(req.params.conversationId);
    const limit = parseLimit(req.query.limit);
    const cursor = req.query.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
        { field: 'cursor', message: 'is not a valid cursor' },
      ]);
    }

    const { items, hasMore, nextCursor } = messageService.listConversation({
      tenantId: req.tenantId,
      conversationId,
      limit,
      cursor,
    });
    res.json({ data: items, pagination: { limit, hasMore, nextCursor } });
  });

  return router;
}
