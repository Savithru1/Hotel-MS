/**
 * Shared constants for the hospitality platform.
 * Guests are a separate principal kind and are deliberately not in STAFF_ROLES.
 */

export const STAFF_ROLES = [
  'platform_admin',
  'property_admin',
  'manager',
  'front_desk',
  'kitchen',
  'housekeeping',
  'maintenance',
  'spa_recreation',
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROOM_STATUSES = [
  'available',
  'occupied',
  'reserved',
  'cleaning',
  'maintenance',
  'out_of_service',
] as const;

export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** Departments a staff member can work in. Realtime rooms and dashboards are per department. */
export const DEPARTMENTS = [
  'front_desk',
  'housekeeping',
  'maintenance',
  'kitchen',
  'spa_recreation',
] as const;

export type Department = (typeof DEPARTMENTS)[number];

/** Roles that work in exactly one department (their role name is the department name). */
export const DEPARTMENT_ROLES = DEPARTMENTS;

export const MANAGEMENT_ROLES = ['platform_admin', 'property_admin', 'manager'] as const;

/**
 * How senior a role is. Staff management only works downwards: nobody can create, change,
 * deactivate or reset an account whose role is at or above their own.
 */
export const ROLE_RANK: Readonly<Record<StaffRole, number>> = {
  platform_admin: 100,
  property_admin: 80,
  manager: 60,
  front_desk: 20,
  kitchen: 20,
  housekeeping: 20,
  maintenance: 20,
  spa_recreation: 20,
};

/** The departments a role belongs to by default. Managers and admins see every department. */
export function defaultDepartments(role: StaffRole): Department[] {
  return (DEPARTMENTS as readonly string[]).includes(role)
    ? [role as Department]
    : [...DEPARTMENTS];
}

export function isManagementRole(role: StaffRole): boolean {
  return (MANAGEMENT_ROLES as readonly string[]).includes(role);
}

/** True when `actor` is senior enough to manage an account that has the role `target`. */
export function outranks(actor: StaffRole, target: StaffRole): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

/** Roles that may be handed out through the API. `platform_admin` is only ever set by seeding. */
export const ASSIGNABLE_ROLES = STAFF_ROLES.filter((role) => role !== 'platform_admin');

/**
 * Which room status can follow which. Anything not listed is refused. An occupied room can only
 * go to cleaning (check-out), and a reserved room cannot be taken out of service while a guest
 * is due, so those need the booking changed first.
 */
export const ROOM_STATUS_TRANSITIONS: Readonly<Record<RoomStatus, readonly RoomStatus[]>> = {
  available: ['reserved', 'occupied', 'cleaning', 'maintenance', 'out_of_service'],
  reserved: ['available', 'occupied'],
  occupied: ['cleaning'],
  cleaning: ['available', 'maintenance', 'out_of_service'],
  maintenance: ['available', 'cleaning', 'out_of_service'],
  out_of_service: ['available', 'cleaning', 'maintenance'],
};

/** The statuses staff may set by hand. The rest are set by bookings and by work queues. */
export const MANUAL_ROOM_STATUSES = ['available', 'cleaning', 'out_of_service'] as const;
export type ManualRoomStatus = (typeof MANUAL_ROOM_STATUSES)[number];

/** Money is whole paise. Nothing in the system stores rupees as a fraction. */
export const PAISE_PER_RUPEE = 100;
export const MAX_ROOM_RATE_PAISE = 50_000_000; // 5 lakh rupees per night

export const GUEST_ID_TYPES = [
  'aadhaar',
  'passport',
  'driving_licence',
  'voter_id',
  'other',
] as const;
export type GuestIdType = (typeof GUEST_ID_TYPES)[number];

export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'checked_in',
  'checked_out',
  'cancelled',
  'no_show',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Pending -> Confirmed -> Checked-in -> Checked-out, plus Cancelled and No-show. */
export const BOOKING_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['checked_out'],
  checked_out: [],
  cancelled: [],
  no_show: [],
};

/** Statuses in which a booking holds its room for the nights of the stay. */
export const NIGHT_HOLDING_STATUSES: readonly BookingStatus[] = [
  'pending',
  'confirmed',
  'checked_in',
];

export const MAX_STAY_NIGHTS = 90;

export const HOUSEKEEPING_STATUSES = ['new', 'in_progress', 'completed', 'cancelled'] as const;
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];

/** New -> In Progress -> Completed. A mistaken request can be cancelled before work starts. */
export const HOUSEKEEPING_TRANSITIONS: Readonly<
  Record<HousekeepingStatus, readonly HousekeepingStatus[]>
> = {
  new: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};

export const SERVICE_REQUEST_TYPES = [
  'towels',
  'toiletries',
  'room_cleaning',
  'pillows_blankets',
  'other',
] as const;
export type ServiceRequestType = (typeof SERVICE_REQUEST_TYPES)[number];

export const MAINTENANCE_STATUSES = ['new', 'assigned', 'in_progress', 'resolved'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

/**
 * New -> Assigned -> In Progress -> Resolved. Handing an issue to someone else is the move
 * Assigned -> Assigned (or In Progress -> Assigned, which puts it back in the queue of the new person).
 */
export const MAINTENANCE_TRANSITIONS: Readonly<
  Record<MaintenanceStatus, readonly MaintenanceStatus[]>
> = {
  new: ['assigned'],
  assigned: ['assigned', 'in_progress'],
  in_progress: ['assigned', 'resolved'],
  resolved: [],
};

export const MAINTENANCE_CATEGORIES = [
  'air_conditioning',
  'tv',
  'wifi',
  'plumbing',
  'electrical',
  'other',
] as const;
export type MaintenanceCategory = (typeof MAINTENANCE_CATEGORIES)[number];

export const MAINTENANCE_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number];

export const REQUEST_PRIORITIES = ['normal', 'urgent'] as const;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];

export const FOOD_ORDER_STATUSES = [
  'received',
  'preparing',
  'ready',
  'delivered',
  'cancelled',
] as const;
export type FoodOrderStatus = (typeof FOOD_ORDER_STATUSES)[number];

/**
 * Received -> Preparing -> Ready to Serve -> Delivered. An order can only be cancelled while it
 * is still Received: once the kitchen has started, the food is made and has to be dealt with.
 */
export const FOOD_ORDER_TRANSITIONS: Readonly<Record<FoodOrderStatus, readonly FoodOrderStatus[]>> =
  {
    received: ['preparing', 'cancelled'],
    preparing: ['ready'],
    ready: ['delivered'],
    delivered: [],
    cancelled: [],
  };

/** Orders the kitchen still has to deal with. */
export const FOOD_ORDER_OPEN_STATUSES: readonly FoodOrderStatus[] = [
  'received',
  'preparing',
  'ready',
];

/** An open order older than this is shown as late on the kitchen screen. */
export const LATE_ORDER_MINUTES = 20;

/** The dearest single menu item or option extra: Rs 10,000. A guard against a typo in the price. */
export const MAX_MENU_PRICE_PAISE = 1_000_000;
export const MAX_OPTION_GROUPS = 10;
export const MAX_CHOICES_PER_GROUP = 20;
export const MAX_ORDER_LINES = 30;
export const MAX_LINE_QUANTITY = 20;

export const FACILITY_TYPES = ['spa', 'pool', 'gym', 'activity', 'other'] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

export const FACILITY_BOOKING_STATUSES = [
  'requested',
  'confirmed',
  'active',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type FacilityBookingStatus = (typeof FACILITY_BOOKING_STATUSES)[number];

/**
 * Requested -> Confirmed -> Active -> Completed. A booking can be cancelled before it starts and
 * marked no-show once confirmed (the slot time has to have passed, which the service checks).
 */
export const FACILITY_BOOKING_TRANSITIONS: Readonly<
  Record<FacilityBookingStatus, readonly FacilityBookingStatus[]>
> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['active', 'cancelled', 'no_show'],
  active: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

/** Statuses in which a booking holds its place in a slot's capacity. */
export const FACILITY_HOLDING_STATUSES: readonly FacilityBookingStatus[] = [
  'requested',
  'confirmed',
  'active',
];

export const MAX_FACILITY_CAPACITY = 100;
export const MIN_SLOT_MINUTES = 15;
export const MAX_SLOT_MINUTES = 480;
/** The dearest facility slot per person: Rs 1,00,000. A guard against a typo in the price. */
export const MAX_FACILITY_PRICE_PAISE = 10_000_000;

export const BILL_STATUSES = ['open', 'finalized'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_LINE_KINDS = ['room', 'food', 'facility', 'charge', 'discount'] as const;
export type BillLineKind = (typeof BILL_LINE_KINDS)[number];

/** The four tax categories a bill line can fall under. */
export const GST_CATEGORIES = ['room', 'food', 'spa_recreation', 'other'] as const;
export type GstCategory = (typeof GST_CATEGORIES)[number];

/**
 * Service accounting codes printed on the invoice. These are this project's understanding and
 * must be confirmed by the property's accountant with the GST rates.
 */
export const SAC_CODES: Readonly<Record<GstCategory, string>> = {
  room: '996311',
  food: '996331',
  spa_recreation: '999722',
  other: '999799',
};

/** What a charge or discount added by hand by staff can be taxed as. Room tax follows the booking. */
export const MANUAL_LINE_CATEGORIES = ['food', 'spa_recreation', 'other'] as const;
export type ManualLineCategory = (typeof MANUAL_LINE_CATEGORIES)[number];

export const PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_KINDS = ['payment', 'refund'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** A manual charge or discount above this (Rs 5,000) needs a manager. */
export const MANUAL_APPROVAL_LIMIT_PAISE = 500_000;
/** The largest single manual line or payment: a guard against a typo. */
export const MAX_BILL_AMOUNT_PAISE = 100_000_000;

/** Only raster formats browsers show safely. SVG can carry scripts, so it is not accepted. */
export const MENU_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type MenuImageType = (typeof MENU_IMAGE_TYPES)[number];
export const MAX_MENU_IMAGE_BYTES = 2 * 1024 * 1024;
