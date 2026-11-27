import { Router } from 'express';
import { authRouter, type LoginLimits } from './modules/auth/auth.routes';
import { bookingRouter } from './modules/bookings/booking.routes';
import { billingRouter, paymentsRouter } from './modules/billing/billing.routes';
import { checkOutRouter } from './modules/billing/checkout.routes';
import { facilityBookingRouter } from './modules/facilities/facility-booking.routes';
import { facilityRouter } from './modules/facilities/facility.routes';
import { foodOrderRouter } from './modules/food-orders/food-order.routes';
import { housekeepingRouter } from './modules/housekeeping/housekeeping.routes';
import { maintenanceRouter } from './modules/maintenance/maintenance.routes';
import { menuRouter } from './modules/menu/menu.routes';
import { notificationRouter } from './modules/notifications/notification.routes';
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
  const {
    tokens,
    auth,
    staff,
    properties,
    rooms,
    guests,
    bookings,
    housekeeping,
    maintenance,
    menu,
    foodOrders,
    facilities,
    facilityBookings,
    billing,
    checkOut,
    notifications,
  } = services;
  const router = Router();
  router.use('/auth', authRouter(tokens, auth, loginLimits));
  router.use('/staff', staffRouter(tokens, auth, staff));
  router.use('/properties', propertyRouter(tokens, auth, properties));
  const roomRoutes = roomRouters(tokens, auth, rooms);
  router.use('/room-types', roomRoutes.roomTypes);
  router.use('/rooms', roomRoutes.rooms);
  router.use('/guests', guestRouter(tokens, auth, guests));
  router.use('/bookings', bookingRouter(tokens, auth, bookings));
  router.use('/bookings', checkOutRouter(tokens, auth, checkOut));
  router.use('/housekeeping', housekeepingRouter(tokens, auth, housekeeping));
  router.use('/maintenance', maintenanceRouter(tokens, auth, maintenance));
  router.use('/menu', menuRouter(tokens, auth, menu));
  router.use('/food-orders', foodOrderRouter(tokens, auth, foodOrders));
  router.use('/facilities', facilityRouter(tokens, auth, facilities));
  router.use('/facility-bookings', facilityBookingRouter(tokens, auth, facilityBookings));
  router.use('/bills', billingRouter(tokens, auth, billing));
  router.use('/payments', paymentsRouter(tokens, auth, billing));
  router.use('/notifications', notificationRouter(tokens, auth, notifications));
  return router;
}
