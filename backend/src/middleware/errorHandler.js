import { AppError } from '../errors.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

/** Every error leaves the service in the same envelope: { error: { code, message, details?, requestId } } */
export function errorHandler({ logger }) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details;

    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'Request body is not valid JSON';
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Request body is too large';
    }

    if (status >= 500) {
      // Log the failure for debugging; the client only ever sees the generic message.
      logger.error('unhandled error', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        errorName: err?.name,
        errorMessage: err?.message,
        stack: err?.stack,
      });
    } else {
      logger.debug('request rejected', { requestId: req.id, status, code });
    }

    res.status(status).json({
      error: { code, message, ...(details ? { details } : {}), requestId: req.id },
    });
  };
}
