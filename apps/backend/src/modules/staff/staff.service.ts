import {
  DEPARTMENTS,
  defaultDepartments,
  isManagementRole,
  outranks,
  type Department,
  type StaffRole,
} from '@hospitality/constants';
import type { StaffDto, StaffWithTemporaryPassword } from '@hospitality/shared-types';
import type { Types } from 'mongoose';
import type { Env } from '../../config/environment';
import { recordAudit } from '../../shared/audit/audit';
import { conflict, forbidden, notFound } from '../../shared/errors';
import { generateTemporaryPassword, hashPassword } from '../../shared/password';
import type { AuthenticatedStaff } from '../auth/auth.types';
import type { TokenService } from '../auth/token.service';
import { Staff } from './staff.model';
import { toStaffDto } from './staff.types';

export interface CreateStaffInput {
  name: string;
  email: string;
  role: string;
  departments?: string[] | undefined;
}

export interface UpdateStaffInput {
  name?: string | undefined;
  role?: string | undefined;
  departments?: string[] | undefined;
  active?: boolean | undefined;
}

export interface ListStaffInput {
  page: number;
  limit: number;
  role?: string | undefined;
  active?: boolean | undefined;
}

export interface StaffService {
  list(input: ListStaffInput): Promise<{ items: StaffDto[]; total: number }>;
  get(id: string): Promise<StaffDto>;
  create(actor: AuthenticatedStaff, input: CreateStaffInput): Promise<StaffWithTemporaryPassword>;
  update(actor: AuthenticatedStaff, id: string, input: UpdateStaffInput): Promise<StaffDto>;
  resetPassword(actor: AuthenticatedStaff, id: string): Promise<StaffWithTemporaryPassword>;
}

/**
 * Departments for a role. Management roles always cover every department; other roles default
 * to their own and may be given extra ones by a manager.
 */
function resolveDepartments(role: StaffRole, requested: string[] | undefined): Department[] {
  if (isManagementRole(role)) return defaultDepartments(role);
  const wanted = (requested ?? []) as Department[];
  return wanted.length > 0
    ? wanted.filter((d) => DEPARTMENTS.includes(d))
    : defaultDepartments(role);
}

export function createStaffService(env: Env, tokens: TokenService): StaffService {
  /** Nobody can act on an account at or above their own level, or on their own account. */
  function assertMayManage(
    actor: AuthenticatedStaff,
    target: { _id: Types.ObjectId; role: StaffRole },
  ) {
    if (target._id.equals(actor.id)) {
      throw forbidden('You cannot change your own account here', 'cannot_manage_self');
    }
    if (!outranks(actor.role, target.role)) {
      throw forbidden('You cannot manage an account at or above your own role', 'role_too_high');
    }
  }

  async function findOrFail(id: string) {
    const staff = await Staff.findOne({ _id: id }).lean();
    if (!staff) throw notFound('Staff member not found');
    return staff;
  }

  return {
    async list({ page, limit, role, active }) {
      const filter = {
        ...(role ? { role: role as StaffRole } : {}),
        ...(active === undefined ? {} : { active }),
      };
      const [items, total] = await Promise.all([
        Staff.find(filter)
          .sort({ name: 1, _id: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Staff.countDocuments(filter),
      ]);
      return { items: items.map(toStaffDto), total };
    },

    async get(id) {
      return toStaffDto(await findOrFail(id));
    },

    async create(actor, input) {
      const role = input.role as StaffRole;
      if (!outranks(actor.role, role)) {
        throw forbidden(
          'You cannot create an account with a role at or above your own',
          'role_too_high',
        );
      }
      if (await Staff.exists({ email: input.email })) {
        throw conflict('A staff member with that email already exists', 'email_taken');
      }

      const temporaryPassword = generateTemporaryPassword();
      const created = await Staff.create({
        name: input.name,
        email: input.email,
        role,
        departments: resolveDepartments(role, input.departments),
        passwordHash: await hashPassword(temporaryPassword, env.BCRYPT_COST),
        mustChangePassword: true,
      });
      await recordAudit({
        action: 'staff.created',
        target: { type: 'staff', id: created._id.toHexString() },
        summary: { role, email: input.email },
      });
      return { staff: toStaffDto(created.toObject()), temporaryPassword };
    },

    async update(actor, id, input) {
      const target = await findOrFail(id);
      assertMayManage(actor, target);

      const nextRole = (input.role ?? target.role) as StaffRole;
      if (input.role && !outranks(actor.role, nextRole)) {
        throw forbidden('You cannot give a role at or above your own', 'role_too_high');
      }

      const set: Record<string, unknown> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.active !== undefined) set.active = input.active;
      if (input.role !== undefined || input.departments !== undefined) {
        set.role = nextRole;
        set.departments = resolveDepartments(
          nextRole,
          input.departments ?? (input.role === undefined ? target.departments : undefined),
        );
      }

      // The role is part of the filter: if the account was promoted while we were deciding, the
      // rank check above no longer applies and the update must not go through.
      const updated = await Staff.findOneAndUpdate(
        { _id: id, role: target.role },
        { $set: set },
        { returnDocument: 'after', runValidators: true },
      ).lean();
      if (!updated) throw notFound('Staff member not found');

      // A demoted or deactivated person must not keep working on tokens issued before the change.
      // (Access tokens are re-checked against the database anyway; this ends refresh as well.)
      if (updated.role !== target.role || (input.active === false && target.active)) {
        await tokens.revokeAllFor(updated._id);
      }
      await recordAudit({
        action: 'staff.updated',
        target: { type: 'staff', id },
        summary: {
          before: { role: target.role, active: target.active, departments: target.departments },
          after: { role: updated.role, active: updated.active, departments: updated.departments },
        },
      });
      return toStaffDto(updated);
    },

    async resetPassword(actor, id) {
      const target = await findOrFail(id);
      assertMayManage(actor, target);

      const temporaryPassword = generateTemporaryPassword();
      const updated = await Staff.findOneAndUpdate(
        { _id: id, role: target.role },
        {
          $set: {
            passwordHash: await hashPassword(temporaryPassword, env.BCRYPT_COST),
            mustChangePassword: true,
            passwordChangedAt: new Date(),
            failedLoginCount: 0,
            lockedUntil: null,
          },
        },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) throw notFound('Staff member not found');

      await tokens.revokeAllFor(updated._id);
      await recordAudit({
        action: 'staff.password_reset',
        target: { type: 'staff', id },
      });
      return { staff: toStaffDto(updated), temporaryPassword };
    },
  };
}
