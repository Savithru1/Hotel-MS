import {
  cancelFacilityBookingSchema,
  createFacilityBookingSchema,
  facilityBookingSummaryQuerySchema,
  idParamsSchema,
  listFacilityBookingsQuerySchema,
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
  CreateFacilityBookingInput,
  FacilityBookingService,
  ListFacilityBookingsInput,
} from './facility-booking.service';

/** Who sees the bookings and may make or cancel one: spa staff, the front desk and management. */
export const FACILITY_BOOKING_STAFF = ['spa_recreation', 'front_desk', ...MANAGEMENT] as const;
/** Running the session (confirm, start, finish, no-show) is the spa and recreation team's job. */
const SPA_TEAM = ['spa_recreation', ...MANAGEMENT] as const;

export function facilityBookingRouter(
  tokens: TokenService,
  auth: AuthService,
  bookings: FacilityBookingService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));
  const idParams = validate({ params: idParamsSchema });
  const idOf = (req: { validated?: { params?: unknown } }): string =>
    (req.validated?.params as { id: string }).id;

  router.post(
    '/',
    requireRole(...FACILITY_BOOKING_STAFF),
    validate({ body: createFacilityBookingSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const created = await bookings.create(
        req.staff,
        req.validated?.body as CreateFacilityBookingInput,
      );
      res.status(201).json({ success: true, data: created });
    },
  );

  router.get(
    '/',
    requireRole(...FACILITY_BOOKING_STAFF),
    validate({ query: listFacilityBookingsQuerySchema }),
    async (req, res) => {
      const query = req.validated?.query as ListFacilityBookingsInput;
      const { items, total } = await bookings.list(query);
      res.json({
        success: true,
        data: items,
        meta: { total, page: query.page, limit: query.limit },
      });
    },
  );

  router.get(
    '/summary',
    requireRole(...FACILITY_BOOKING_STAFF),
    validate({ query: facilityBookingSummaryQuerySchema }),
    async (req, res) => {
      const { date } = req.validated?.query as { date: string };
      res.json({ success: true, data: await bookings.summary(date) });
    },
  );

  router.get('/:id', requireRole(...FACILITY_BOOKING_STAFF), idParams, async (req, res) => {
    res.json({ success: true, data: await bookings.get(idOf(req)) });
  });

  router.post('/:id/confirm', requireRole(...SPA_TEAM), idParams, async (req, res) => {
    res.json({ success: true, data: await bookings.confirm(idOf(req)) });
  });

  router.post('/:id/start', requireRole(...SPA_TEAM), idParams, async (req, res) => {
    res.json({ success: true, data: await bookings.start(idOf(req)) });
  });

  router.post('/:id/complete', requireRole(...SPA_TEAM), idParams, async (req, res) => {
    res.json({ success: true, data: await bookings.complete(idOf(req)) });
  });

  router.post('/:id/no-show', requireRole(...SPA_TEAM), idParams, async (req, res) => {
    res.json({ success: true, data: await bookings.noShow(idOf(req)) });
  });

  router.post(
    '/:id/cancel',
    requireRole(...FACILITY_BOOKING_STAFF),
    validate({ params: idParamsSchema, body: cancelFacilityBookingSchema }),
    async (req, res) => {
      const { reason } = req.validated?.body as { reason: string };
      res.json({ success: true, data: await bookings.cancel(idOf(req), reason) });
    },
  );

  const base = { tag: 'Facility bookings', secured: true } as const;
  documentRoute({
    ...base,
    method: 'post',
    path: '/facility-bookings',
    summary:
      'Book a slot for the guest in a room. The server sets the price; capacity is enforced atomically',
    roles: FACILITY_BOOKING_STAFF,
    body: createFacilityBookingSchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/facility-bookings',
    summary: 'Bookings in time order, filterable by date, facility, room and status',
    roles: FACILITY_BOOKING_STAFF,
    query: listFacilityBookingsQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/facility-bookings/summary',
    summary: 'A day by status, and how many people are expected',
    roles: FACILITY_BOOKING_STAFF,
    query: facilityBookingSummaryQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/facility-bookings/:id',
    summary: 'One facility booking',
    roles: FACILITY_BOOKING_STAFF,
    params: idParamsSchema,
  });
  for (const [step, summary] of [
    ['confirm', 'Confirm a request (Requested to Confirmed)'],
    ['start', 'Start the session (Confirmed to Active)'],
    ['complete', 'Finish the session (Active to Completed). Tells billing, once'],
    ['no-show', 'Mark a confirmed booking as a no-show once its slot time has passed'],
  ] as const) {
    documentRoute({
      ...base,
      method: 'post',
      path: `/facility-bookings/:id/${step}`,
      summary,
      roles: SPA_TEAM,
      params: idParamsSchema,
    });
  }
  documentRoute({
    ...base,
    method: 'post',
    path: '/facility-bookings/:id/cancel',
    summary: 'Cancel a booking that has not started, freeing its places',
    roles: FACILITY_BOOKING_STAFF,
    params: idParamsSchema,
    body: cancelFacilityBookingSchema,
  });

  return router;
}
