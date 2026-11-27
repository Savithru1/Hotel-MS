import { listNotificationsQuerySchema, markReadParamsSchema } from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import { unauthorized } from '../../shared/errors';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type { ListNotificationsInput, NotificationService } from './notification.service';

/**
 * A staff member's own notifications. Open to every signed-in role: every query is filtered by
 * the id on the verified token, so nobody can read or change anyone else's.
 */
export function notificationRouter(
  tokens: TokenService,
  auth: AuthService,
  notifications: NotificationService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));

  router.get('/', validate({ query: listNotificationsQuerySchema }), async (req, res) => {
    if (!req.staff) throw unauthorized();
    const query = req.validated?.query as ListNotificationsInput;
    const { items, total } = await notifications.listForStaff(req.staff.id, query);
    res.json({ success: true, data: items, meta: { total, page: query.page, limit: query.limit } });
  });

  router.get('/unread-count', async (req, res) => {
    if (!req.staff) throw unauthorized();
    res.json({ success: true, data: { unread: await notifications.unreadCount(req.staff.id) } });
  });

  router.post('/read-all', async (req, res) => {
    if (!req.staff) throw unauthorized();
    res.json({ success: true, data: { updated: await notifications.markAllRead(req.staff.id) } });
  });

  router.post('/:id/read', validate({ params: markReadParamsSchema }), async (req, res) => {
    if (!req.staff) throw unauthorized();
    const { id } = req.validated?.params as { id: string };
    res.json({ success: true, data: await notifications.markRead(req.staff.id, id) });
  });

  const base = { tag: 'Notifications', secured: true } as const;
  documentRoute({
    ...base,
    method: 'get',
    path: '/notifications',
    summary: 'My notifications, newest first',
    query: listNotificationsQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/notifications/unread-count',
    summary: 'How many unread notifications I have',
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/notifications/read-all',
    summary: 'Mark all of my notifications read',
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/notifications/:id/read',
    summary: 'Mark one of my notifications read',
    params: markReadParamsSchema,
  });

  return router;
}
