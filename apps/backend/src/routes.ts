import { Router } from 'express';
import { authRouter, type LoginLimits } from './modules/auth/auth.routes';
import { staffRouter } from './modules/staff/staff.routes';
import type { Services } from './services';

export interface ApiOptions {
  services: Services;
  loginLimits?: LoginLimits;
}

/** All versioned API routes. Mounted at `/api/v1` by `createApp`. */
export function buildApiRouter({ services, loginLimits }: ApiOptions): Router {
  const { tokens, auth, staff } = services;
  const router = Router();
  router.use('/auth', authRouter(tokens, auth, loginLimits));
  router.use('/staff', staffRouter(tokens, auth, staff));
  return router;
}
