import {
  ASSIGNABLE_ROLES,
  DEPARTMENTS,
  outranks,
  type Department,
  type StaffRole,
} from '@hospitality/constants';
import type { StaffDto } from '@hospitality/shared-types';

/** What the edit form holds while someone is typing. */
export interface StaffDraft {
  name: string;
  role: StaffRole;
  departments: Department[];
  /** True once the person has ticked or unticked a department themselves. */
  departmentsEdited: boolean;
}

/** The fields the server accepts in `PATCH /staff/:id` that this form can change. */
export interface StaffUpdate {
  name?: string;
  role?: StaffRole;
  departments?: Department[];
}

export function draftFrom(person: StaffDto): StaffDraft {
  return {
    name: person.name,
    role: person.role,
    departments: [...person.departments],
    departmentsEdited: false,
  };
}

/**
 * Roles the actor may give: strictly below their own, as the server enforces. The server stays the
 * authority; this only keeps the list free of choices that would be refused.
 */
export function assignableRoles(actorRole: StaffRole): StaffRole[] {
  return ASSIGNABLE_ROLES.filter((role) => outranks(actorRole, role));
}

const inDepartmentOrder = (values: readonly Department[]): Department[] =>
  DEPARTMENTS.filter((department) => values.includes(department));

const sameSet = (a: readonly Department[], b: readonly Department[]): boolean =>
  a.length === b.length && a.every((department) => b.includes(department));

/**
 * Only what changed. Departments are sent only when the person edited them: a role change on its
 * own lets the server pick the new role's default departments. `null` means nothing changed.
 */
export function buildStaffUpdate(original: StaffDto, draft: StaffDraft): StaffUpdate | null {
  const update: StaffUpdate = {};
  const name = draft.name.trim();
  if (name !== original.name) update.name = name;
  if (draft.role !== original.role) update.role = draft.role;
  if (draft.departmentsEdited && !sameSet(draft.departments, original.departments)) {
    update.departments = inDepartmentOrder(draft.departments);
  }
  return Object.keys(update).length > 0 ? update : null;
}
