import { auditLogQuerySchema } from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type { AuditService, ListAuditInput } from './audit.service';

/** Who did what, read-only, for management. There is deliberately no route that writes. */
export function auditRouter(tokens: TokenService, auth: AuthService, audit: AuditService): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));
  router.use(requireRole(...MANAGEMENT));

  router.get('/', validate({ query: auditLogQuerySchema }), async (req, res) => {
    const query = req.validated?.query as ListAuditInput;
    const { items, total } = await audit.list(query);
    res.json({ success: true, data: items, meta: { total, page: query.page, limit: query.limit } });
  });

  documentRoute({
    tag: 'Audit',
    secured: true,
    roles: [...MANAGEMENT],
    method: 'get',
    path: '/audit-logs',
    summary:
      'The audit log, newest first, filterable by date, action, person and record. Secrets are removed',
    query: auditLogQuerySchema,
  });

  return router;
}
