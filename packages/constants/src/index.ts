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
