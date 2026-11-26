import {
  createFacilitySchema,
  idParamsSchema,
  listFacilitiesQuerySchema,
  slotsQuerySchema,
  updateFacilitySchema,
} from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type {
  CreateFacilityInput,
  FacilityService,
  ListFacilitiesInput,
  UpdateFacilityInput,
} from './facility.service';

/** Who can see facilities and their slots: spa staff, the front desk and management. */
export const FACILITY_VIEWERS = ['spa_recreation', 'front_desk', ...MANAGEMENT] as const;

export function facilityRouter(
  tokens: TokenService,
  auth: AuthService,
  facilities: FacilityService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));
  const idParams = validate({ params: idParamsSchema });
  const idOf = (req: { validated?: { params?: unknown } }): string =>
    (req.validated?.params as { id: string }).id;

  router.get(
    '/',
    requireRole(...FACILITY_VIEWERS),
    validate({ query: listFacilitiesQuerySchema }),
    async (req, res) => {
      const query = req.validated?.query as ListFacilitiesInput;
      const { items, total } = await facilities.list(query);
      res.json({
        success: true,
        data: items,
        meta: { total, page: query.page, limit: query.limit },
      });
    },
  );

  router.post(
    '/',
    requireRole(...MANAGEMENT),
    validate({ body: createFacilitySchema }),
    async (req, res) => {
      const created = await facilities.create(req.validated?.body as CreateFacilityInput);
      res.status(201).json({ success: true, data: created });
    },
  );

  router.get('/:id', requireRole(...FACILITY_VIEWERS), idParams, async (req, res) => {
    res.json({ success: true, data: await facilities.get(idOf(req)) });
  });

  router.patch(
    '/:id',
    requireRole(...MANAGEMENT),
    validate({ params: idParamsSchema, body: updateFacilitySchema }),
    async (req, res) => {
      const updated = await facilities.update(
        idOf(req),
        req.validated?.body as UpdateFacilityInput,
      );
      res.json({ success: true, data: updated });
    },
  );

  router.get(
    '/:id/slots',
    requireRole(...FACILITY_VIEWERS),
    validate({ params: idParamsSchema, query: slotsQuerySchema }),
    async (req, res) => {
      const { date } = req.validated?.query as { date: string };
      res.json({ success: true, data: await facilities.slots(idOf(req), date) });
    },
  );

  const base = { tag: 'Facilities', secured: true } as const;
  documentRoute({
    ...base,
    method: 'get',
    path: '/facilities',
    summary: 'Spa, pool, gym and activities',
    roles: FACILITY_VIEWERS,
    query: listFacilitiesQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/facilities',
    summary: 'Add a facility (hours, slot length, capacity, price)',
    roles: MANAGEMENT,
    body: createFacilitySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/facilities/:id',
    summary: 'One facility',
    roles: FACILITY_VIEWERS,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'patch',
    path: '/facilities/:id',
    summary:
      'Change a facility. Hours, slot length and capacity cannot change while open bookings hold slots',
    roles: MANAGEMENT,
    params: idParamsSchema,
    body: updateFacilitySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/facilities/:id/slots',
    summary: 'The slots of one day with capacity, bookings and whether each can be booked',
    roles: FACILITY_VIEWERS,
    params: idParamsSchema,
    query: slotsQuerySchema,
  });

  return router;
}
