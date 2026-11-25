import { Router } from 'express';
import { z } from 'zod';
import { errorResponseSchema, registry } from './shared/openapi';

const healthResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({
      status: z.literal('ok'),
      database: z.literal('up'),
    }),
  })
  .openapi('HealthResponse');

registry.registerPath({
  method: 'get',
  path: '/health',
  summary: 'Service health',
  description: 'Used by uptime checks. Not rate limited. Reveals nothing about the system.',
  responses: {
    200: {
      description: 'The service and its database are up.',
      content: { 'application/json': { schema: healthResponseSchema } },
    },
    503: {
      description: 'The database is not reachable.',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

export function healthRouter(checkDatabase: () => boolean): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    if (checkDatabase()) {
      res.json({ success: true, data: { status: 'ok', database: 'up' } });
      return;
    }
    // Sent directly, not through the error handler, so frequent uptime checks do not flood the
    // error log while the database is down.
    res.status(503).json({
      success: false,
      error: { code: 'unhealthy', message: 'Database is not reachable' },
      requestId: res.getHeader('x-request-id'),
    });
  });

  return router;
}
