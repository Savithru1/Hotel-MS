import { Router } from 'express';
import type { Env } from './config/environment';
import { authRouter, type LoginLimits } from './modules/auth/auth.routes';
import { createAuthService } from './modules/auth/auth.service';
import { createTokenService } from './modules/auth/token.service';
import { staffRouter } from './modules/staff/staff.routes';
import { createStaffService } from './modules/staff/staff.service';

export interface ApiOptions {
  env: Env;
  loginLimits?: LoginLimits;
}

/** All versioned API routes. Mounted at `/api/v1` by `createApp`. */
export function buildApiRouter({ env, loginLimits }: ApiOptions): Router {
  const tokens = createTokenService(env);
  const auth = createAuthService(env, tokens);
  const staff = createStaffService(env, tokens);

  const router = Router();
  router.use('/auth', authRouter(tokens, auth, loginLimits));
  router.use('/staff', staffRouter(tokens, auth, staff));
  return router;
}
