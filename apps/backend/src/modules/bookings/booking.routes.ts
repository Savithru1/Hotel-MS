import {
  availabilityQuerySchema,
  calendarQuerySchema,
  cancelBookingSchema,
  checkInBookingSchema,
  createBookingSchema,
  idParamsSchema,
  listBookingsQuerySchema,
  updateBookingSchema,
} from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type {
  BookingService,
  CheckInInput,
  CreateBookingInput,
  UpdateBookingInput,
} from './booking.service';
import type { AvailabilityInput, ListBookingsInput } from './booking.queries';

/** Bookings are created and run by the front desk and management only. */
export const BOOKING_ROLES = ['front_desk', ...MANAGEMENT] as const;

export function bookingRouter(
  tokens: TokenService,
  auth: AuthService,
  bookings: BookingService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth), requireRole(...BOOKING_ROLES));
  const idParams = validate({ params: idParamsSchema });
  const idOf = (req: { validated?: { params?: unknown } }): string =>
    (req.validated?.params as { id: string }).id;

  // Fixed paths come before `/:id`.
  router.get('/availability', validate({ query: availabilityQuerySchema }), async (req, res) => {
    res.json({
      success: true,
      data: await bookings.availability(req.validated?.query as AvailabilityInput),
    });
  });

  router.get('/overview', async (_req, res) => {
    res.json({ success: true, data: await bookings.overview() });
  });

  router.get('/calendar', validate({ query: calendarQuerySchema }), async (req, res) => {
    const { from, to } = req.validated?.query as { from: string; to: string };
    res.json({ success: true, data: await bookings.calendar(from, to) });
  });

  router.get('/', validate({ query: listBookingsQuerySchema }), async (req, res) => {
    const query = req.validated?.query as ListBookingsInput;
    const { items, total } = await bookings.list(query);
    res.json({ success: true, data: items, meta: { total, page: query.page, limit: query.limit } });
  });

  router.post('/', validate({ body: createBookingSchema }), async (req, res) => {
    const created = await bookings.create(req.validated?.body as CreateBookingInput);
    res.status(201).json({ success: true, data: created });
  });

  router.get('/:id', idParams, async (req, res) => {
    res.json({ success: true, data: await bookings.get(idOf(req)) });
  });

  router.patch(
    '/:id',
    validate({ params: idParamsSchema, body: updateBookingSchema }),
    async (req, res) => {
      res.json({
        success: true,
        data: await bookings.update(idOf(req), req.validated?.body as UpdateBookingInput),
      });
    },
  );

  router.post('/:id/confirm', idParams, async (req, res) => {
    res.json({ success: true, data: await bookings.confirm(idOf(req)) });
  });

  router.post(
    '/:id/cancel',
    validate({ params: idParamsSchema, body: cancelBookingSchema }),
    async (req, res) => {
      const { reason } = req.validated?.body as { reason: string };
      res.json({ success: true, data: await bookings.cancel(idOf(req), reason) });
    },
  );

  router.post('/:id/no-show', idParams, async (req, res) => {
    res.json({ success: true, data: await bookings.markNoShow(idOf(req)) });
  });

  router.post(
    '/:id/check-in',
    validate({ params: idParamsSchema, body: checkInBookingSchema }),
    async (req, res) => {
      res.json({
        success: true,
        data: await bookings.checkIn(idOf(req), req.validated?.body as CheckInInput),
      });
    },
  );

  const doc = { tag: 'Bookings', secured: true, roles: BOOKING_ROLES } as const;
  documentRoute({
    ...doc,
    method: 'get',
    path: '/bookings/availability',
    summary: 'Free rooms by type for a date range',
    query: availabilityQuerySchema,
  });
  documentRoute({
    ...doc,
    method: 'get',
    path: '/bookings/overview',
    summary: 'Front desk: arrivals, departures, in-house and room status counts for today',
  });
  documentRoute({
    ...doc,
    method: 'get',
    path: '/bookings/calendar',
    summary: 'Bookings overlapping a date window',
    query: calendarQuerySchema,
  });
  documentRoute({
    ...doc,
    method: 'get',
    path: '/bookings',
    summary: 'Search and list bookings',
    query: listBookingsQuerySchema,
  });
  documentRoute({
    ...doc,
    method: 'post',
    path: '/bookings',
    summary: 'Create a booking (holds the room nights)',
    body: createBookingSchema,
  });
  documentRoute({
    ...doc,
    method: 'get',
    path: '/bookings/:id',
    summary: 'Get a booking',
    params: idParamsSchema,
  });
  documentRoute({
    ...doc,
    method: 'patch',
    path: '/bookings/:id',
    summary: 'Change dates, room, guests or notes',
    params: idParamsSchema,
    body: updateBookingSchema,
  });
  documentRoute({
    ...doc,
    method: 'post',
    path: '/bookings/:id/confirm',
    summary: 'Confirm a pending booking',
    params: idParamsSchema,
  });
  documentRoute({
    ...doc,
    method: 'post',
    path: '/bookings/:id/cancel',
    summary: 'Cancel a booking and free its nights',
    params: idParamsSchema,
    body: cancelBookingSchema,
  });
  documentRoute({
    ...doc,
    method: 'post',
    path: '/bookings/:id/no-show',
    summary: 'Mark a no-show and free its nights',
    params: idParamsSchema,
  });
  documentRoute({
    ...doc,
    method: 'post',
    path: '/bookings/:id/check-in',
    summary: 'Check the guest in and mark the room occupied',
    params: idParamsSchema,
    body: checkInBookingSchema,
  });

  return router;
}
