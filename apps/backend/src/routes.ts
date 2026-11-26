import { Router } from 'express';
import { authRouter, type LoginLimits } from './modules/auth/auth.routes';
import { bookingRouter } from './modules/bookings/booking.routes';
import { propertyRouter } from './modules/properties/property.routes';
import { roomRouters } from './modules/rooms/room.routes';
import { staffRouter } from './modules/staff/staff.routes';
import { guestRouter } from './modules/users/guest.routes';
import type { Services } from './services';

export interface ApiOptions {
  services: Services;
  loginLimits?: LoginLimits;
}

/** All versioned API routes. Mounted at `/api/v1` by `createApp`. */
export function buildApiRouter({ services, loginLimits }: ApiOptions): Router {
  const { tokens, auth, staff, properties, rooms, guests, bookings } = services;
  const router = Router();
  router.use('/auth', authRouter(tokens, auth, loginLimits));
  router.use('/staff', staffRouter(tokens, auth, staff));
  router.use('/properties', propertyRouter(tokens, auth, properties));
  const roomRoutes = roomRouters(tokens, auth, rooms);
  router.use('/room-types', roomRoutes.roomTypes);
  router.use('/rooms', roomRoutes.rooms);
  router.use('/guests', guestRouter(tokens, auth, guests));
  router.use('/bookings', bookingRouter(tokens, auth, bookings));
  return router;
}
