import { Router } from 'express';
import { webhookAuth } from '../middleware/webhookAuth.js';
import { validateWebhookEvent } from '../validation.js';

export function webhooksRouter({ webhookService, config }) {
  const router = Router();
  router.use(webhookAuth(config));

  // POST /api/v1/webhooks/provider
  router.post('/provider', (req, res) => {
    const event = validateWebhookEvent(req.body);
    const result = webhookService.process(event, { requestId: req.id });
    // The event is committed before this line runs, so 200 means "durably recorded".
    res.status(200).json({ data: result });
  });

  return router;
}
