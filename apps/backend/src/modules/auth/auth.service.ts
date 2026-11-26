import type { Session } from '@hospitality/shared-types';
import type { Types } from 'mongoose';
import type { Env } from '../../config/environment';
import { recordAudit } from '../../shared/audit/audit';
import { HttpError, unauthorized } from '../../shared/errors';
import { hashPassword, verifyPassword } from '../../shared/password';
import { runAsPlatform, runWithPrincipal, runWithTenant } from '../../shared/request-context';
import { Property } from '../properties/property.model';
import { Staff, type StaffDocument } from '../staff/staff.model';
import { toStaffDto } from '../staff/staff.types';
import type { AuthenticatedStaff } from './auth.types';
import type { IssuedRefreshToken, TokenService } from './token.service';

/** After this many wrong passwords in a row the account is locked for a while. */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60_000;

// One message for every sign-in failure (wrong property, unknown email, wrong password, locked,
// deactivated), so the endpoint cannot be used to find out which accounts exist.
const LOGIN_FAILED_MESSAGE = 'Those details are not correct, or the account is temporarily locked.';
const loginFailed = (): HttpError => unauthorized(LOGIN_FAILED_MESSAGE, 'invalid_credentials');

export interface LoginInput {
  propertySlug: string;
  email: string;
  password: string;
}

export interface AuthService {
  login(input: LoginInput): Promise<Session>;
  refresh(refreshToken: string): Promise<Session>;
  logout(refreshToken: string): Promise<void>;
  changePassword(staff: AuthenticatedStaff, current: string, next: string): Promise<Session>;
  /** Loads the account behind a verified access token. Returns null if it may not act. */
  loadActiveStaff(
    staffId: Types.ObjectId,
    propertyId: Types.ObjectId,
  ): Promise<AuthenticatedStaff | null>;
  /** The current staff member and property, for `GET /auth/me`. */
  describe(staff: AuthenticatedStaff): Promise<Omit<Session, 'tokens'>>;
}

type StaffRecord = Omit<StaffDocument, 'passwordHash'> & { passwordHash?: string };

function toAuthenticated(staff: StaffRecord): AuthenticatedStaff {
  return {
    id: staff._id,
    propertyId: staff.propertyId,
    name: staff.name,
    email: staff.email,
    role: staff.role,
    departments: [...staff.departments],
    mustChangePassword: staff.mustChangePassword,
  };
}

export function createAuthService(env: Env, tokens: TokenService): AuthService {
  // Compared against when the email is unknown, so "no such account" takes as long as "wrong
  // password" and timing does not reveal which accounts exist.
  const dummyHash = hashPassword('not-a-real-password-1', env.BCRYPT_COST);

  async function buildSession(
    staff: StaffRecord,
    propertyId: Types.ObjectId,
    refresh: IssuedRefreshToken,
  ): Promise<Session> {
    const property = await runAsPlatform(() => Property.findById(propertyId).lean());
    if (!property) throw unauthorized();
    const accessToken = await tokens.signAccessToken({ staffId: staff._id, propertyId });
    return {
      tokens: {
        accessToken,
        expiresIn: tokens.accessTtlSeconds,
        refreshToken: refresh.token,
      },
      staff: toStaffDto(staff),
      property: { id: property._id.toHexString(), name: property.name, slug: property.slug },
    };
  }

  const loadStaff = (staffId: Types.ObjectId, propertyId: Types.ObjectId) =>
    runWithTenant(propertyId, () => Staff.findOne({ _id: staffId }).lean());

  async function recordFailure(staff: StaffRecord, reason: string): Promise<void> {
    await runWithTenant(staff.propertyId, async () => {
      const updated = await Staff.findOneAndUpdate(
        { _id: staff._id },
        { $inc: { failedLoginCount: 1 } },
        { returnDocument: 'after' },
      ).lean();
      const locked = (updated?.failedLoginCount ?? 0) >= MAX_FAILED_LOGINS;
      if (locked) {
        await Staff.updateOne(
          { _id: staff._id },
          { $set: { lockedUntil: new Date(Date.now() + LOCKOUT_MS), failedLoginCount: 0 } },
        );
      }
      await recordAudit({
        action: locked ? 'auth.account_locked' : 'auth.login_failed',
        target: { type: 'staff', id: staff._id.toHexString() },
        summary: { reason },
      });
    });
  }

  return {
    async login({ propertySlug, email, password }) {
      const property = await runAsPlatform(() =>
        Property.findOne({ slug: propertySlug, active: true }).lean(),
      );
      const staff = property
        ? await runWithTenant(property._id, () =>
            Staff.findOne({ email }).select('+passwordHash').lean(),
          )
        : null;

      // Always compare, even with nothing to compare against, to keep the timing the same.
      const passwordOk = await verifyPassword(password, staff?.passwordHash ?? (await dummyHash));

      if (!property || !staff) throw loginFailed();

      const locked = staff.lockedUntil !== null && staff.lockedUntil > new Date();
      if (!passwordOk || locked || !staff.active) {
        await recordFailure(staff, locked ? 'locked' : !staff.active ? 'inactive' : 'bad_password');
        throw loginFailed();
      }

      await runWithTenant(property._id, () =>
        Staff.updateOne(
          { _id: staff._id },
          { $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } },
        ),
      );
      const refresh = await tokens.issueRefreshToken({
        staffId: staff._id,
        propertyId: property._id,
      });
      await runWithPrincipal(
        { kind: 'staff', id: staff._id.toHexString(), role: staff.role },
        property._id,
        () =>
          recordAudit({
            action: 'auth.login',
            target: { type: 'staff', id: staff._id.toHexString() },
          }),
      );
      return buildSession({ ...staff, lastLoginAt: new Date() }, property._id, refresh);
    },

    async refresh(refreshToken) {
      const rotated = await tokens.rotateRefreshToken(refreshToken);
      const staff = await loadStaff(rotated.staffId, rotated.propertyId);
      if (!staff?.active) {
        await tokens.revokeAllFor(rotated.staffId);
        throw unauthorized(
          'Your session has expired, please sign in again',
          'invalid_refresh_token',
        );
      }
      return buildSession(staff, rotated.propertyId, rotated);
    },

    async logout(refreshToken) {
      await tokens.revokeFamilyOf(refreshToken);
    },

    async changePassword(staff, current, next) {
      const record = await runWithTenant(staff.propertyId, () =>
        Staff.findOne({ _id: staff.id }).select('+passwordHash').lean(),
      );
      if (!record || !(await verifyPassword(current, record.passwordHash))) {
        throw new HttpError(400, 'wrong_password', 'The current password is not correct');
      }
      if (await verifyPassword(next, record.passwordHash)) {
        throw new HttpError(
          400,
          'password_unchanged',
          'The new password must be different from the current one',
        );
      }

      const passwordHash = await hashPassword(next, env.BCRYPT_COST);
      const updated = await runWithTenant(staff.propertyId, async () => {
        const result = await Staff.findOneAndUpdate(
          { _id: staff.id },
          {
            $set: {
              passwordHash,
              mustChangePassword: false,
              passwordChangedAt: new Date(),
              failedLoginCount: 0,
              lockedUntil: null,
            },
          },
          { returnDocument: 'after' },
        ).lean();
        await recordAudit({
          action: 'auth.password_changed',
          target: { type: 'staff', id: staff.id.toHexString() },
        });
        return result;
      });
      if (!updated) throw unauthorized();

      // Every other device must sign in again with the new password.
      await tokens.revokeAllFor(staff.id);
      const refresh = await tokens.issueRefreshToken({
        staffId: staff.id,
        propertyId: staff.propertyId,
      });
      return buildSession(updated, staff.propertyId, refresh);
    },

    async loadActiveStaff(staffId, propertyId) {
      const staff = await loadStaff(staffId, propertyId);
      if (!staff?.active) return null;
      return toAuthenticated(staff);
    },

    async describe(staff) {
      const [record, property] = await Promise.all([
        loadStaff(staff.id, staff.propertyId),
        runAsPlatform(() => Property.findById(staff.propertyId).lean()),
      ]);
      if (!record || !property) throw unauthorized();
      return {
        staff: toStaffDto(record),
        property: { id: property._id.toHexString(), name: property.name, slug: property.slug },
      };
    },
  };
}
