import type { Env } from './config/environment';
import { createAuthService, type AuthService } from './modules/auth/auth.service';
import { createTokenService, type TokenService } from './modules/auth/token.service';
import { createBookingService, type BookingService } from './modules/bookings/booking.service';
import { createPropertyService, type PropertyService } from './modules/properties/property.service';
import { createRoomService, type RoomService } from './modules/rooms/room.service';
import { createStaffService, type StaffService } from './modules/staff/staff.service';
import { createGuestService, type GuestService } from './modules/users/guest.service';

/** The long-lived services, built once and shared by the HTTP routes and the realtime gateway. */
export interface Services {
  tokens: TokenService;
  auth: AuthService;
  staff: StaffService;
  properties: PropertyService;
  rooms: RoomService;
  guests: GuestService;
  bookings: BookingService;
}

export function buildServices(env: Env): Services {
  const tokens = createTokenService(env);
  const properties = createPropertyService();
  const rooms = createRoomService();
  return {
    tokens,
    auth: createAuthService(env, tokens),
    staff: createStaffService(env, tokens),
    properties,
    rooms,
    guests: createGuestService(),
    bookings: createBookingService(properties, rooms),
  };
}
