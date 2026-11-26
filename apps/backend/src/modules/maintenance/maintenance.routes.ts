import {
  assignSchema,
  createMaintenanceIssueSchema,
  escalateSchema,
  idParamsSchema,
  listMaintenanceQuerySchema,
  resolveMaintenanceSchema,
} from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { unauthorized } from '../../shared/errors';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type { CreateIssueInput, ListIssuesInput, MaintenanceService } from './maintenance.service';

/** Who sees the maintenance queue. Housekeeping can report a problem but does not see the queue. */
export const MAINTENANCE_VIEWERS = ['maintenance', 'front_desk', ...MANAGEMENT] as const;
const REPORTERS = ['front_desk', 'housekeeping', 'maintenance', ...MANAGEMENT] as const;
const WORKERS = ['maintenance', ...MANAGEMENT] as const;
const DESK = ['front_desk', ...MANAGEMENT] as const;

export function maintenanceRouter(
  tokens: TokenService,
  auth: AuthService,
  maintenance: MaintenanceService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));
  const idParams = validate({ params: idParamsSchema });
  const idOf = (req: { validated?: { params?: unknown } }): string =>
    (req.validated?.params as { id: string }).id;

  router.post(
    '/',
    requireRole(...REPORTERS),
    validate({ body: createMaintenanceIssueSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const created = await maintenance.create(req.staff, req.validated?.body as CreateIssueInput);
      res.status(201).json({ success: true, data: created });
    },
  );

  router.get(
    '/',
    requireRole(...MAINTENANCE_VIEWERS),
    validate({ query: listMaintenanceQuerySchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const query = req.validated?.query as ListIssuesInput;
      const { items, total } = await maintenance.list(req.staff, query);
      res.json({
        success: true,
        data: items,
        meta: { total, page: query.page, limit: query.limit },
      });
    },
  );

  router.get('/summary', requireRole(...MAINTENANCE_VIEWERS), async (_req, res) => {
    res.json({ success: true, data: await maintenance.summary() });
  });

  router.get('/:id', requireRole(...MAINTENANCE_VIEWERS), idParams, async (req, res) => {
    res.json({ success: true, data: await maintenance.get(idOf(req)) });
  });

  // Managers assign anyone; a technician can only take an unassigned issue for themselves
  // (the service enforces that).
  router.post(
    '/:id/assign',
    requireRole(...WORKERS),
    validate({ params: idParamsSchema, body: assignSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { staffId } = req.validated?.body as { staffId: string };
      res.json({ success: true, data: await maintenance.assign(req.staff, idOf(req), staffId) });
    },
  );

  router.post('/:id/start', requireRole(...WORKERS), idParams, async (req, res) => {
    if (!req.staff) throw unauthorized();
    res.json({ success: true, data: await maintenance.start(req.staff, idOf(req)) });
  });

  router.post(
    '/:id/resolve',
    requireRole(...WORKERS),
    validate({ params: idParamsSchema, body: resolveMaintenanceSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { resolutionNote } = req.validated?.body as { resolutionNote: string };
      res.json({
        success: true,
        data: await maintenance.resolve(req.staff, idOf(req), resolutionNote),
      });
    },
  );

  router.post(
    '/:id/escalate',
    requireRole(...MAINTENANCE_VIEWERS),
    validate({ params: idParamsSchema, body: escalateSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { reason } = req.validated?.body as { reason: string };
      res.json({ success: true, data: await maintenance.escalate(req.staff, idOf(req), reason) });
    },
  );

  router.post('/:id/acknowledge', requireRole(...DESK), idParams, async (req, res) => {
    if (!req.staff) throw unauthorized();
    res.json({ success: true, data: await maintenance.acknowledge(req.staff, idOf(req)) });
  });

  const base = { tag: 'Maintenance', secured: true } as const;
  documentRoute({
    ...base,
    method: 'post',
    path: '/maintenance',
    summary: 'Report an issue (can take the room out of service)',
    roles: REPORTERS,
    body: createMaintenanceIssueSchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/maintenance',
    summary: 'The maintenance queue',
    roles: MAINTENANCE_VIEWERS,
    query: listMaintenanceQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/maintenance/summary',
    summary: 'Counts by status for the dashboard',
    roles: MAINTENANCE_VIEWERS,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/maintenance/:id',
    summary: 'One issue',
    roles: MAINTENANCE_VIEWERS,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/maintenance/:id/assign',
    summary: 'Assign or reassign a technician (a technician may take an unassigned issue)',
    roles: WORKERS,
    params: idParamsSchema,
    body: assignSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/maintenance/:id/start',
    summary: 'Start work',
    roles: WORKERS,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/maintenance/:id/resolve',
    summary: 'Resolve; releases a room the issue held out of service',
    roles: WORKERS,
    params: idParamsSchema,
    body: resolveMaintenanceSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/maintenance/:id/escalate',
    summary: 'Flag for the front desk and managers',
    roles: MAINTENANCE_VIEWERS,
    params: idParamsSchema,
    body: escalateSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/maintenance/:id/acknowledge',
    summary: 'Clear an escalation flag',
    roles: DESK,
    params: idParamsSchema,
  });

  return router;
}
