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
