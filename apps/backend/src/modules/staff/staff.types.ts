import type { StaffDto } from '@hospitality/shared-types';
import type { StaffDocument } from './staff.model';

type StaffLike = Omit<StaffDocument, 'passwordHash'>;

/** What the API shows about a staff account. Never includes the password hash or lock counters. */
export function toStaffDto(staff: StaffLike): StaffDto {
  return {
    id: staff._id.toHexString(),
    propertyId: staff.propertyId.toHexString(),
    name: staff.name,
    email: staff.email,
    role: staff.role,
    departments: [...staff.departments],
    active: staff.active,
    mustChangePassword: staff.mustChangePassword,
    lastLoginAt: staff.lastLoginAt ? staff.lastLoginAt.toISOString() : null,
    createdAt: staff.createdAt.toISOString(),
  };
}
