import {
  assignSchema,
  completeSchema,
  createHousekeepingRequestSchema,
  escalateSchema,
  idParamsSchema,
  listHousekeepingQuerySchema,
} from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { unauthorized } from '../../shared/errors';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type {
  CreateHousekeepingInput,
  HousekeepingService,
  ListHousekeepingInput,
} from './housekeeping.service';

/** Who sees the housekeeping queue. Kitchen, maintenance and spa staff do not. */
export const HOUSEKEEPING_VIEWERS = ['housekeeping', 'front_desk', ...MANAGEMENT] as const;
const WORKERS = ['housekeeping', ...MANAGEMENT] as const;
const DESK = ['front_desk', ...MANAGEMENT] as const;
const ESCALATORS = ['housekeeping', 'front_desk', ...MANAGEMENT] as const;

export function housekeepingRouter(
  tokens: TokenService,
  auth: AuthService,
  housekeeping: HousekeepingService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));
  const idParams = validate({ params: idParamsSchema });
  const idOf = (req: { validated?: { params?: unknown } }): string =>
    (req.validated?.params as { id: string }).id;

  router.post(
    '/',
    requireRole('front_desk', 'housekeeping', ...MANAGEMENT),
    validate({ body: createHousekeepingRequestSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const created = await housekeeping.create(
        req.staff,
        req.validated?.body as CreateHousekeepingInput,
      );
      res.status(201).json({ success: true, data: created });
    },
  );

  router.get(
    '/',
    requireRole(...HOUSEKEEPING_VIEWERS),
    validate({ query: listHousekeepingQuerySchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const query = req.validated?.query as ListHousekeepingInput;
      const { items, total } = await housekeeping.list(req.staff, query);
      res.json({
        success: true,
        data: items,
        meta: { total, page: query.page, limit: query.limit },
      });
    },
  );

  router.get('/summary', requireRole(...HOUSEKEEPING_VIEWERS), async (_req, res) => {
    res.json({ success: true, data: await housekeeping.summary() });
  });

  router.get('/:id', requireRole(...HOUSEKEEPING_VIEWERS), idParams, async (req, res) => {
    res.json({ success: true, data: await housekeeping.get(idOf(req)) });
  });

  router.post(
    '/:id/assign',
    requireRole(...MANAGEMENT),
    validate({ params: idParamsSchema, body: assignSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { staffId } = req.validated?.body as { staffId: string };
      res.json({ success: true, data: await housekeeping.assign(req.staff, idOf(req), staffId) });
    },
  );

  router.post('/:id/start', requireRole(...WORKERS), idParams, async (req, res) => {
    if (!req.staff) throw unauthorized();
    res.json({ success: true, data: await housekeeping.start(req.staff, idOf(req)) });
  });

  router.post(
    '/:id/complete',
    requireRole(...WORKERS),
    validate({ params: idParamsSchema, body: completeSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { note } = req.validated?.body as { note?: string };
      res.json({ success: true, data: await housekeeping.complete(req.staff, idOf(req), note) });
    },
  );

  router.post(
    '/:id/cancel',
    requireRole(...DESK),
    validate({ params: idParamsSchema, body: escalateSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { reason } = req.validated?.body as { reason: string };
      res.json({ success: true, data: await housekeeping.cancel(req.staff, idOf(req), reason) });
    },
  );

  router.post(
    '/:id/escalate',
    requireRole(...ESCALATORS),
    validate({ params: idParamsSchema, body: escalateSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { reason } = req.validated?.body as { reason: string };
      res.json({ success: true, data: await housekeeping.escalate(req.staff, idOf(req), reason) });
    },
  );

  router.post('/:id/acknowledge', requireRole(...DESK), idParams, async (req, res) => {
    if (!req.staff) throw unauthorized();
    res.json({ success: true, data: await housekeeping.acknowledge(req.staff, idOf(req)) });
  });

  const tag = 'Housekeeping';
  const base = { tag, secured: true } as const;
  documentRoute({
    ...base,
    method: 'post',
    path: '/housekeeping',
    summary: 'Log a housekeeping request or cleaning task',
    roles: ['front_desk', 'housekeeping', ...MANAGEMENT],
    body: createHousekeepingRequestSchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/housekeeping',
    summary: 'The housekeeping queue',
    roles: HOUSEKEEPING_VIEWERS,
    query: listHousekeepingQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/housekeeping/summary',
    summary: 'Counts by status for the dashboard',
    roles: HOUSEKEEPING_VIEWERS,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/housekeeping/:id',
    summary: 'One request',
    roles: HOUSEKEEPING_VIEWERS,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/housekeeping/:id/assign',
    summary: 'Assign an unstarted task to a housekeeper',
    roles: MANAGEMENT,
    params: idParamsSchema,
    body: assignSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/housekeeping/:id/start',
    summary: 'Start work (claims the task)',
    roles: WORKERS,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/housekeeping/:id/complete',
    summary: 'Complete; a finished room cleaning frees the room',
    roles: WORKERS,
    params: idParamsSchema,
    body: completeSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/housekeeping/:id/cancel',
    summary: 'Cancel a task that has not started',
    roles: DESK,
    params: idParamsSchema,
    body: escalateSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/housekeeping/:id/escalate',
    summary: 'Flag for the front desk and managers',
    roles: ESCALATORS,
    params: idParamsSchema,
    body: escalateSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/housekeeping/:id/acknowledge',
    summary: 'Clear an escalation flag',
    roles: DESK,
    params: idParamsSchema,
  });

  return router;
}
