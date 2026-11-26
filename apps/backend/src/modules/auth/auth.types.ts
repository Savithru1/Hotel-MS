import type { Department, StaffRole } from '@hospitality/constants';
import type { Types } from 'mongoose';

/** The signed-in staff member, re-read from the database on every request. */
export interface AuthenticatedStaff {
  id: Types.ObjectId;
  propertyId: Types.ObjectId;
  name: string;
  email: string;
  role: StaffRole;
  departments: Department[];
  mustChangePassword: boolean;
}
