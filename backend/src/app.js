import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createMessageService } from './services/messageService.js';
import { createWebhookService } from './services/webhookService.js';
import { conversationsRouter, messagesRouter } from './routes/messages.js';
import { webhooksRouter } from './routes/webhooks.js';
import { healthRouter } from './routes/health.js';

const FRONTEND_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');

export function createApp({ db, config, logger, metrics }) {
  const messageService = createMessageService(db);
  const webhookService = createWebhookService(db, { logger, metrics });

  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext({ logger, metrics }));
  app.use(express.json({ limit: '16kb' }));

  // Express resets req.baseUrl when an error leaves a router, so remember the mount path
  // up front: the access log and metrics need a stable route label for error responses too.
  const mount = (base, router) =>
    app.use(
      base,
      (req, _res, next) => {
        req.routeBase = base;
        next();
      },
      router,
    );

  app.use(healthRouter({ db, metrics }));
  mount('/api/v1/messages', messagesRouter({ messageService, config, logger, metrics }));
  mount('/api/v1/conversations', conversationsRouter({ messageService }));
  mount('/api/v1/webhooks', webhooksRouter({ webhookService, config }));

  // Optionally serve the built React console (after `npm run build:web`).
  if (fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
    app.use(express.static(FRONTEND_DIST));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        return res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
      }
      next();
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler({ logger }));
  return app;
}
