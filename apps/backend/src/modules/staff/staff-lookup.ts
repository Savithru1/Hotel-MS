import type { Department } from '@hospitality/constants';
import type { AssigneeDto } from '@hospitality/shared-types';
import type { Types } from 'mongoose';
import { badRequest } from '../../shared/errors';
import { Staff } from './staff.model';

/** Names for a set of staff ids, for showing "assigned to" on queues. Runs inside the tenant. */
export async function assigneeMap(
  ids: (Types.ObjectId | null)[],
): Promise<Map<string, AssigneeDto>> {
  const wanted = [...new Set(ids.filter((id): id is Types.ObjectId => id !== null))];
  if (wanted.length === 0) return new Map();
  const people = await Staff.find({ _id: { $in: wanted } }, { name: 1 }).lean();
  return new Map(
    people.map((person) => [
      person._id.toHexString(),
      { id: person._id.toHexString(), name: person.name },
    ]),
  );
}

/**
 * Checks that `staffId` is an active staff member of this property who works in `department`,
 * so work can only be handed to someone who can actually see and do it.
 */
export async function assertAssignable(
  staffId: string,
  department: Department,
): Promise<{ id: Types.ObjectId; name: string }> {
  const person = await Staff.findOne(
    { _id: staffId, active: true },
    { name: 1, departments: 1 },
  ).lean();
  if (!person?.departments.includes(department)) {
    throw badRequest(
      `That person does not work in ${department.replace('_', ' ')}`,
      'not_assignable',
    );
  }
  return { id: person._id, name: person.name };
}
