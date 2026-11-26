import { MANAGEMENT_ROLES, type StaffRole } from '@hospitality/constants';

const MANAGEMENT: readonly StaffRole[] = MANAGEMENT_ROLES;
const FRONT_DESK_TEAM: readonly StaffRole[] = ['front_desk', ...MANAGEMENT];

export interface NavItem {
  path: string;
  label: string;
  /** Roles that may open this page. The server enforces the same rules; this only hides links. */
  roles: readonly StaffRole[];
  group: 'Front desk' | 'Operations' | 'Setup';
}

/** Every page of the staff app and who may open it, in the order shown in the menu. */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/front-desk', label: 'Today', roles: FRONT_DESK_TEAM, group: 'Front desk' },
  { path: '/bookings', label: 'Bookings', roles: FRONT_DESK_TEAM, group: 'Front desk' },
  { path: '/bookings/new', label: 'New booking', roles: FRONT_DESK_TEAM, group: 'Front desk' },
  { path: '/calendar', label: 'Calendar', roles: FRONT_DESK_TEAM, group: 'Front desk' },
  { path: '/guests', label: 'Guests', roles: FRONT_DESK_TEAM, group: 'Front desk' },
  { path: '/bills', label: 'Bills', roles: FRONT_DESK_TEAM, group: 'Front desk' },
  { path: '/payments', label: 'Payments', roles: FRONT_DESK_TEAM, group: 'Front desk' },
  {
    path: '/housekeeping',
    label: 'Housekeeping',
    roles: ['housekeeping', 'front_desk', ...MANAGEMENT],
    group: 'Operations',
  },
  {
    path: '/maintenance',
    label: 'Maintenance',
    roles: ['maintenance', 'front_desk', ...MANAGEMENT],
    group: 'Operations',
  },
  {
    path: '/kitchen',
    label: 'Kitchen',
    roles: ['kitchen', 'front_desk', ...MANAGEMENT],
    group: 'Operations',
  },
  {
    path: '/spa',
    label: 'Spa & recreation',
    roles: ['spa_recreation', 'front_desk', ...MANAGEMENT],
    group: 'Operations',
  },
  { path: '/rooms', label: 'Rooms', roles: FRONT_DESK_TEAM, group: 'Setup' },
  { path: '/room-types', label: 'Room types', roles: MANAGEMENT, group: 'Setup' },
  { path: '/menu', label: 'Menu', roles: MANAGEMENT, group: 'Setup' },
  { path: '/facilities', label: 'Facilities', roles: MANAGEMENT, group: 'Setup' },
  { path: '/staff', label: 'Staff', roles: MANAGEMENT, group: 'Setup' },
  { path: '/property', label: 'Property', roles: MANAGEMENT, group: 'Setup' },
];

export function navFor(role: StaffRole): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

export function canOpen(role: StaffRole, path: string): boolean {
  const item = NAV_ITEMS.find((candidate) => candidate.path === path);
  return item ? item.roles.includes(role) : false;
}

/** The first page a person lands on after signing in. */
export function homePathFor(role: StaffRole): string {
  if (role === 'housekeeping') return '/housekeeping';
  if (role === 'maintenance') return '/maintenance';
  if (role === 'kitchen') return '/kitchen';
  if (role === 'spa_recreation') return '/spa';
  return '/front-desk';
}

export const isManager = (role: StaffRole): boolean => MANAGEMENT.includes(role);
export const isPropertyAdmin = (role: StaffRole): boolean =>
  role === 'property_admin' || role === 'platform_admin';
