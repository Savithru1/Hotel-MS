import { Types } from 'mongoose';
import { runWithTenant } from '../../shared/request-context';
import { Staff } from '../staff/staff.model';

/**
 * The active property admins and managers of one property, as staff ids. Runs inside that
 * property, so it can never return people from another one.
 */
export function managersOf(propertyId: Types.ObjectId | string): Promise<string[]> {
  const tenant = typeof propertyId === 'string' ? new Types.ObjectId(propertyId) : propertyId;
  return runWithTenant(tenant, async () => {
    const people = await Staff.find(
      { active: true, role: { $in: ['property_admin', 'manager'] } },
      { _id: 1 },
    ).lean();
    return people.map((person) => person._id.toHexString());
  });
}
