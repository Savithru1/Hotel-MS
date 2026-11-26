import {
  createGuestSchema,
  idParamsSchema,
  searchGuestsQuerySchema,
  updateGuestSchema,
} from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type {
  CreateGuestInput,
  GuestService,
  SearchGuestsInput,
  UpdateGuestInput,
} from './guest.service';

/** Who may see and edit guest records: the front desk and management. */
export const GUEST_DESK_ROLES = ['front_desk', ...MANAGEMENT] as const;

export function guestRouter(tokens: TokenService, auth: AuthService, guests: GuestService): Router {
  const router = Router();
  router.use(authenticate(tokens, auth), requireRole(...GUEST_DESK_ROLES));

  router.get('/', validate({ query: searchGuestsQuerySchema }), async (req, res) => {
    const query = req.validated?.query as SearchGuestsInput;
    const { items, total } = await guests.search(query);
    res.json({ success: true, data: items, meta: { total, page: query.page, limit: query.limit } });
  });

  router.get('/:id', validate({ params: idParamsSchema }), async (req, res) => {
    const { id } = req.validated?.params as { id: string };
    res.json({ success: true, data: await guests.get(id) });
  });

  router.get('/:id/id-details', validate({ params: idParamsSchema }), async (req, res) => {
    const { id } = req.validated?.params as { id: string };
    res.json({ success: true, data: await guests.readIdDetails(id) });
  });

  router.post('/', validate({ body: createGuestSchema }), async (req, res) => {
    const created = await guests.create(req.validated?.body as CreateGuestInput);
    res.status(201).json({ success: true, data: created });
  });

  router.patch(
    '/:id',
    validate({ params: idParamsSchema, body: updateGuestSchema }),
    async (req, res) => {
      const { id } = req.validated?.params as { id: string };
      res.json({
        success: true,
        data: await guests.update(id, req.validated?.body as UpdateGuestInput),
      });
    },
  );

  const doc = { tag: 'Guests', secured: true, roles: GUEST_DESK_ROLES } as const;
  documentRoute({
    ...doc,
    method: 'get',
    path: '/guests',
    summary: 'Search guests by name, phone or email',
    query: searchGuestsQuerySchema,
  });
  documentRoute({
    ...doc,
    method: 'get',
    path: '/guests/:id',
    summary: 'Get a guest profile',
    params: idParamsSchema,
  });
  documentRoute({
    ...doc,
    method: 'get',
    path: '/guests/:id/id-details',
    summary: 'Read ID document details (audit logged)',
    params: idParamsSchema,
  });
  documentRoute({
    ...doc,
    method: 'post',
    path: '/guests',
    summary: 'Create a guest profile',
    body: createGuestSchema,
  });
  documentRoute({
    ...doc,
    method: 'patch',
    path: '/guests/:id',
    summary: 'Change a guest profile',
    params: idParamsSchema,
    body: updateGuestSchema,
  });

  return router;
}
