import { changePasswordSchema, refreshSchema, staffLoginSchema } from '@hospitality/validation';
import { Router, type Response } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import { documentRoute } from '../../shared/openapi';
import { unauthorized } from '../../shared/errors';
import type { AuthService } from './auth.service';
import type { TokenService } from './token.service';

export interface LoginLimits {
  windowMs: number;
  /** Attempts per address, across all accounts. */
  perAddress: number;
  /** Attempts per address and account. */
  perAddressAndAccount: number;
}

export const DEFAULT_LOGIN_LIMITS: LoginLimits = {
  windowMs: 15 * 60_000,
  perAddress: 60,
  perAddressAndAccount: 10,
};

const tooMany = (_req: unknown, res: Response): void => {
  res.status(429).json({
    success: false,
    error: { code: 'rate_limited', message: 'Too many sign-in attempts, please try again later.' },
    requestId: res.getHeader('x-request-id'),
  });
};

export function authRouter(
  tokens: TokenService,
  auth: AuthService,
  limits: LoginLimits = DEFAULT_LOGIN_LIMITS,
): Router {
  const router = Router();
  const authenticateEvenIfPasswordChangePending = authenticate(tokens, auth, {
    allowPasswordChangePending: true,
  });

  const byAddress = rateLimit({
    windowMs: limits.windowMs,
    limit: limits.perAddress,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: tooMany,
  });
  const byAddressAndAccount = rateLimit({
    windowMs: limits.windowMs,
    limit: limits.perAddressAndAccount,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const body = (req.body ?? {}) as { propertySlug?: unknown; email?: unknown };
      const account = `${String(body.propertySlug ?? '')}|${String(body.email ?? '')}`
        .toLowerCase()
        .slice(0, 200);
      return `${ipKeyGenerator(req.ip ?? '')}|${account}`;
    },
    handler: tooMany,
  });

  router.post(
    '/login',
    byAddress,
    byAddressAndAccount,
    validate({ body: staffLoginSchema }),
    async (req, res) => {
      const session = await auth.login(req.validated?.body as Parameters<AuthService['login']>[0]);
      res.json({ success: true, data: session });
    },
  );

  router.post('/refresh', byAddress, validate({ body: refreshSchema }), async (req, res) => {
    const { refreshToken } = req.validated?.body as { refreshToken: string };
    res.json({ success: true, data: await auth.refresh(refreshToken) });
  });

  router.post('/logout', validate({ body: refreshSchema }), async (req, res) => {
    const { refreshToken } = req.validated?.body as { refreshToken: string };
    await auth.logout(refreshToken);
    res.json({ success: true, data: { loggedOut: true } });
  });

  router.get('/me', authenticateEvenIfPasswordChangePending, async (req, res) => {
    if (!req.staff) throw unauthorized();
    res.json({ success: true, data: await auth.describe(req.staff) });
  });

  router.post(
    '/change-password',
    authenticateEvenIfPasswordChangePending,
    validate({ body: changePasswordSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { currentPassword, newPassword } = req.validated?.body as {
        currentPassword: string;
        newPassword: string;
      };
      res.json({
        success: true,
        data: await auth.changePassword(req.staff, currentPassword, newPassword),
      });
    },
  );

  documentRoute({
    method: 'post',
    path: '/auth/login',
    tag: 'Auth',
    summary: 'Staff sign-in',
    body: staffLoginSchema,
  });
  documentRoute({
    method: 'post',
    path: '/auth/refresh',
    tag: 'Auth',
    summary: 'Exchange a refresh token for a new session',
    body: refreshSchema,
  });
  documentRoute({
    method: 'post',
    path: '/auth/logout',
    tag: 'Auth',
    summary: 'Sign out and revoke the refresh token',
    body: refreshSchema,
  });
  documentRoute({
    method: 'get',
    path: '/auth/me',
    tag: 'Auth',
    summary: 'The signed-in staff member and property',
    secured: true,
  });
  documentRoute({
    method: 'post',
    path: '/auth/change-password',
    tag: 'Auth',
    summary: 'Change your own password',
    secured: true,
    body: changePasswordSchema,
  });

  return router;
}
