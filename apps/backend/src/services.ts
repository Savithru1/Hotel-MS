import type { Env } from './config/environment';
import { createAuthService, type AuthService } from './modules/auth/auth.service';
import { createTokenService, type TokenService } from './modules/auth/token.service';
import { createBookingService, type BookingService } from './modules/bookings/booking.service';
import { createBillingService, type BillingService } from './modules/billing/billing.service';
import { createCheckOutService, type CheckOutService } from './modules/billing/checkout.service';
import {
  createFacilityBookingService,
  type FacilityBookingService,
} from './modules/facilities/facility-booking.service';
import { createFacilityService, type FacilityService } from './modules/facilities/facility.service';
import {
  createFoodOrderService,
  type FoodOrderService,
} from './modules/food-orders/food-order.service';
import { createAuditService, type AuditService } from './modules/manager/audit.service';
import { createManagerService, type ManagerService } from './modules/manager/manager.service';
import { createMenuService, type MenuService } from './modules/menu/menu.service';
import {
  createHousekeepingService,
  type HousekeepingService,
} from './modules/housekeeping/housekeeping.service';
import {
  createMaintenanceService,
  type MaintenanceService,
} from './modules/maintenance/maintenance.service';
import {
  createNotificationService,
  type NotificationService,
} from './modules/notifications/notification.service';
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
  housekeeping: HousekeepingService;
  maintenance: MaintenanceService;
  menu: MenuService;
  foodOrders: FoodOrderService;
  facilities: FacilityService;
  facilityBookings: FacilityBookingService;
  billing: BillingService;
  checkOut: CheckOutService;
  notifications: NotificationService;
  manager: ManagerService;
  audit: AuditService;
}

export function buildServices(env: Env): Services {
  const tokens = createTokenService(env);
  const properties = createPropertyService();
  const rooms = createRoomService();
  const billing = createBillingService(properties);
  return {
    tokens,
    auth: createAuthService(env, tokens),
    staff: createStaffService(env, tokens),
    properties,
    rooms,
    guests: createGuestService(),
    bookings: createBookingService(properties, rooms),
    housekeeping: createHousekeepingService(rooms),
    maintenance: createMaintenanceService(rooms),
    menu: createMenuService(),
    foodOrders: createFoodOrderService(),
    facilities: createFacilityService(properties),
    facilityBookings: createFacilityBookingService(properties),
    billing,
    checkOut: createCheckOutService(properties, billing, rooms),
    notifications: createNotificationService(),
    manager: createManagerService(properties),
    audit: createAuditService(properties),
  };
}
