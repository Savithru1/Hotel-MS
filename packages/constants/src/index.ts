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
