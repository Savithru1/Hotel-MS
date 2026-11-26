import { checkOutSchema, idParamsSchema } from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { unauthorized } from '../../shared/errors';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import { BILLING_STAFF } from './billing.routes';
import type { CheckOutService } from './checkout.service';

/** `POST /bookings/:id/check-out`, mounted next to the booking routes. */
export function checkOutRouter(
  tokens: TokenService,
  auth: AuthService,
  checkOut: CheckOutService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));

  router.post(
    '/:id/check-out',
    requireRole(...BILLING_STAFF),
    validate({ params: idParamsSchema, body: checkOutSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const { id } = req.validated?.params as { id: string };
      const input = req.validated?.body as { overrideReason?: string | undefined };
      res.json({ success: true, data: await checkOut.checkOut(req.staff, id, input) });
    },
  );

  documentRoute({
    tag: 'Bookings',
    secured: true,
    method: 'post',
    path: '/bookings/:id/check-out',
    summary:
      'Check a guest out: issues the invoice, requires a zero balance (a manager can override with a reason), marks the room for cleaning and puts the unused nights back on sale',
    roles: BILLING_STAFF,
    params: idParamsSchema,
    body: checkOutSchema,
  });

  return router;
}
