import type { Env } from './config/environment';
import { createAuthService, type AuthService } from './modules/auth/auth.service';
import { createTokenService, type TokenService } from './modules/auth/token.service';
import { createStaffService, type StaffService } from './modules/staff/staff.service';

/** The long-lived services, built once and shared by the HTTP routes and the realtime gateway. */
export interface Services {
  tokens: TokenService;
  auth: AuthService;
  staff: StaffService;
}

export function buildServices(env: Env): Services {
  const tokens = createTokenService(env);
  return {
    tokens,
    auth: createAuthService(env, tokens),
    staff: createStaffService(env, tokens),
  };
}
