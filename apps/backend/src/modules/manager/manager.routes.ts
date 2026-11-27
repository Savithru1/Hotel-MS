import { overviewQuerySchema, statsRangeQuerySchema } from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type { ManagerService, RangeInput } from './manager.service';

/** The manager dashboard and statistics. Management roles only, for their own property. */
export function managerRouter(
  tokens: TokenService,
  auth: AuthService,
  manager: ManagerService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));
  router.use(requireRole(...MANAGEMENT));

  const rangeOf = (req: { validated?: { query?: unknown } }): RangeInput =>
    req.validated?.query as RangeInput;
  const range = validate({ query: statsRangeQuerySchema });

  router.get('/overview', validate({ query: overviewQuerySchema }), async (req, res) => {
    const { date } = req.validated?.query as { date?: string };
    res.json({ success: true, data: await manager.overview(date) });
  });
  router.get('/stats/occupancy', range, async (req, res) => {
    res.json({ success: true, data: await manager.occupancy(rangeOf(req)) });
  });
  router.get('/stats/revenue', range, async (req, res) => {
    res.json({ success: true, data: await manager.revenue(rangeOf(req)) });
  });
  router.get('/stats/response-times', range, async (req, res) => {
    res.json({ success: true, data: await manager.responseTimes(rangeOf(req)) });
  });

  const base = { tag: 'Manager', secured: true, roles: [...MANAGEMENT] } as const;
  documentRoute({
    ...base,
    method: 'get',
    path: '/manager/overview',
    summary: 'Rooms, arrivals, occupancy, work queues and escalations for one day',
    query: overviewQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/manager/stats/occupancy',
    summary: 'Occupied rooms per day for a date range (at most 92 days)',
    query: statsRangeQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/manager/stats/revenue',
    summary: 'Revenue by day and department (GST apart), credit notes, payments and refunds',
    query: statsRangeQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/manager/stats/response-times',
    summary: 'Average time to first action and to completion: housekeeping, maintenance, kitchen',
    query: statsRangeQuerySchema,
  });

  return router;
}
