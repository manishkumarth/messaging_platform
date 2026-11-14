import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

const digest = (value) => createHash('sha256').update(value).digest();

/**
 * Shared-secret check for the provider webhook. Comparing fixed-length SHA-256 digests
 * with timingSafeEqual avoids leaking the secret through timing or length differences.
 * If no secret is configured the check is skipped (local experiments only).
 */
export function webhookAuth({ webhookSecret }) {
  return (req, _res, next) => {
    if (!webhookSecret) return next();
    const provided = req.get('x-webhook-secret') ?? '';
    if (!timingSafeEqual(digest(provided), digest(webhookSecret))) {
      throw new AppError(401, 'INVALID_WEBHOOK_SECRET', 'Missing or invalid x-webhook-secret header');
    }
    next();
  };
}
