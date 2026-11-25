import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
}

/**
 * Limits requests per client address. The counters live in memory, which is correct for a
 * single backend instance (see the hosting notes in the plan).
 */
export function createRateLimiter({ windowMs, limit }: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        error: { code: 'rate_limited', message: 'Too many requests, please try again later.' },
        requestId: res.getHeader('x-request-id'),
      });
    },
  });
}
