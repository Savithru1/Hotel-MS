import type { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../shared/errors';
import { bindPrincipal } from '../shared/request-context';
import type { AuthService } from '../modules/auth/auth.service';
import type { TokenService } from '../modules/auth/token.service';

export interface AuthenticateOptions {
  /**
   * Accounts that must still change a temporary password may only use the few routes that set
   * `true` here (change password, who am I, sign out).
   */
  allowPasswordChangePending?: boolean;
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/**
 * Requires a valid access token. The token only identifies the person; the role, departments
 * and active state are re-read from the database on every request, so deactivating or demoting
 * an account takes effect immediately. After this runs, `req.staff` and the request context
 * (tenant and principal) are set, and nothing else in the request may be trusted for identity.
 */
export function authenticate(
  tokens: TokenService,
  auth: AuthService,
  { allowPasswordChangePending = false }: AuthenticateOptions = {},
): RequestHandler {
  return async (req, _res, next) => {
    const match = BEARER.exec(req.get('authorization') ?? '');
    if (!match?.[1]) throw unauthorized();

    let claims;
    try {
      claims = await tokens.verifyAccessToken(match[1]);
    } catch {
      throw unauthorized('Your session has expired, please sign in again', 'invalid_token');
    }

    const staff = await auth.loadActiveStaff(claims.staffId, claims.propertyId, claims.issuedAt);
    if (!staff) {
      throw unauthorized('Your session has expired, please sign in again', 'invalid_token');
    }
    if (staff.mustChangePassword && !allowPasswordChangePending) {
      throw forbidden('You must change your temporary password first', 'password_change_required');
    }

    bindPrincipal(
      { kind: 'staff', id: staff.id.toHexString(), role: staff.role },
      staff.propertyId,
    );
    req.staff = staff;
    next();
  };
}
