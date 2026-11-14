import { Router } from 'express';

export function healthRouter({ db, metrics }) {
  const router = Router();

  // GET /health : liveness plus a database connectivity probe. No connection strings or paths.
  router.get('/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', checks: { database: 'up' }, uptimeSeconds: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ status: 'degraded', checks: { database: 'down' }, uptimeSeconds: Math.round(process.uptime()) });
    }
  });

  // GET /metrics : in-process counters as JSON (volume + failures)
  router.get('/metrics', (_req, res) => {
    res.json({ data: metrics.snapshot() });
  });

  return router;
}
