import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { runWithContext } from '../shared/request-context';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Gives every request an id (kept from the client if it is well formed, otherwise generated),
 * echoes it in `X-Request-Id`, and opens the per-request context that the rest of the request
 * runs inside. Must be the first middleware.
 */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();

    req.id = requestId;
    res.setHeader('x-request-id', requestId);
    runWithContext({ requestId, ip: req.ip }, next);
  };
}
