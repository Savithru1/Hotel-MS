import {
  createStaffSchema,
  listStaffQuerySchema,
  staffIdParamsSchema,
  updateStaffSchema,
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
  CreateStaffInput,
  ListStaffInput,
  StaffService,
  UpdateStaffInput,
} from './staff.service';

export function staffRouter(tokens: TokenService, auth: AuthService, staff: StaffService): Router {
  const router = Router();
  router.use(authenticate(tokens, auth), requireRole(...MANAGEMENT));

  router.get('/', validate({ query: listStaffQuerySchema }), async (req, res) => {
    const query = req.validated?.query as ListStaffInput;
    const { items, total } = await staff.list(query);
    res.json({
      success: true,
      data: items,
      meta: { total, page: query.page, limit: query.limit },
    });
  });

  router.get('/:id', validate({ params: staffIdParamsSchema }), async (req, res) => {
    const { id } = req.validated?.params as { id: string };
    res.json({ success: true, data: await staff.get(id) });
  });

  router.post('/', validate({ body: createStaffSchema }), async (req, res) => {
    if (!req.staff) throw unauthorized();
    const created = await staff.create(req.staff, req.validated?.body as CreateStaffInput);
    res.status(201).json({ success: true, data: created });
  });

  router.patch(
    '/:id',
    validate({ params: staffIdParamsSchema, body: updateStaffSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { id } = req.validated?.params as { id: string };
      const updated = await staff.update(req.staff, id, req.validated?.body as UpdateStaffInput);
      res.json({ success: true, data: updated });
    },
  );

  router.post(
    '/:id/reset-password',
    validate({ params: staffIdParamsSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { id } = req.validated?.params as { id: string };
      res.json({ success: true, data: await staff.resetPassword(req.staff, id) });
    },
  );

  const doc = { tag: 'Staff', secured: true, roles: MANAGEMENT } as const;
  documentRoute({
    ...doc,
    method: 'get',
    path: '/staff',
    summary: 'List staff',
    query: listStaffQuerySchema,
  });
  documentRoute({
    ...doc,
    method: 'get',
    path: '/staff/:id',
    summary: 'Get one staff member',
    params: staffIdParamsSchema,
  });
  documentRoute({
    ...doc,
    method: 'post',
    path: '/staff',
    summary: 'Create a staff member with a temporary password',
    body: createStaffSchema,
  });
  documentRoute({
    ...doc,
    method: 'patch',
    path: '/staff/:id',
    summary: 'Change name, role, departments or active state',
    params: staffIdParamsSchema,
    body: updateStaffSchema,
  });
  documentRoute({
    ...doc,
    method: 'post',
    path: '/staff/:id/reset-password',
    summary: 'Reset a password to a new temporary one',
    params: staffIdParamsSchema,
  });

  return router;
}
