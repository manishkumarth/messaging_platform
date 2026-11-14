import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Correlation id + access log + request counter.
 * Logs method, route pattern, status, latency and ids only: never bodies, query strings,
 * phone numbers or headers.
 */
export function requestContext({ logger, metrics }) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.id);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const route = req.route
        ? `${req.routeBase ?? ''}${req.route.path}`.replace(/(.)\/$/, '$1')
        : (req.routeBase ?? 'unmatched');
      metrics.inc('http_requests_total', { method: req.method, route, status: res.statusCode });
      logger.info('request completed', {
        requestId: req.id,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        tenantId: req.tenantId,
      });
    });
    next();
  };
}
