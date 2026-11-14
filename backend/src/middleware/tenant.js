import { AppError } from '../errors.js';
import { validateTenantId } from '../validation.js';

/**
 * ASSUMPTION: x-tenant-id stands in for an authenticated identity. In production the
 * tenant would be derived from a verified credential (JWT claim / API key lookup) by an
 * auth layer and never trusted from a client-controlled header or body.
 */
export function requireTenant(req, _res, next) {
  const tenantId = req.get('x-tenant-id');
  if (!tenantId) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Missing x-tenant-id header');
  }
  if (!validateTenantId(tenantId)) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid x-tenant-id header');
  }
  req.tenantId = tenantId;
  next();
}
