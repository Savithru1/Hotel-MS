import {
  cancelFoodOrderSchema,
  createFoodOrderSchema,
  idParamsSchema,
  listFoodOrdersQuerySchema,
} from '@hospitality/validation';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { unauthorized } from '../../shared/errors';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type {
  CreateFoodOrderInput,
  FoodOrderService,
  ListFoodOrdersInput,
} from './food-order.service';

/** Who sees the order queue and who may place or deliver an order. */
export const FOOD_ORDER_STAFF = ['kitchen', 'front_desk', ...MANAGEMENT] as const;
/** Cooking is the kitchen's job (managers can step in). The front desk does not start or finish it. */
const COOKS = ['kitchen', ...MANAGEMENT] as const;

export function foodOrderRouter(
  tokens: TokenService,
  auth: AuthService,
  orders: FoodOrderService,
): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));
  const idParams = validate({ params: idParamsSchema });
  const idOf = (req: { validated?: { params?: unknown } }): string =>
    (req.validated?.params as { id: string }).id;

  router.post(
    '/',
    requireRole(...FOOD_ORDER_STAFF),
    validate({ body: createFoodOrderSchema }),
    async (req, res) => {
      if (!req.staff) throw unauthorized();
      const created = await orders.create(req.staff, req.validated?.body as CreateFoodOrderInput);
      res.status(201).json({ success: true, data: created });
    },
  );

  router.get(
    '/',
    requireRole(...FOOD_ORDER_STAFF),
    validate({ query: listFoodOrdersQuerySchema }),
    async (req, res) => {
      const query = req.validated?.query as ListFoodOrdersInput;
      const { items, total } = await orders.list(query);
      res.json({
        success: true,
        data: items,
        meta: { total, page: query.page, limit: query.limit },
      });
    },
  );

  router.get('/summary', requireRole(...FOOD_ORDER_STAFF), async (_req, res) => {
    res.json({ success: true, data: await orders.summary() });
  });

  router.get('/:id', requireRole(...FOOD_ORDER_STAFF), idParams, async (req, res) => {
    res.json({ success: true, data: await orders.get(idOf(req)) });
  });

  router.post('/:id/start', requireRole(...COOKS), idParams, async (req, res) => {
    res.json({ success: true, data: await orders.start(idOf(req)) });
  });

  router.post('/:id/ready', requireRole(...COOKS), idParams, async (req, res) => {
    res.json({ success: true, data: await orders.ready(idOf(req)) });
  });

  // The front desk can mark an order delivered: it is often the one that carries it up.
  router.post('/:id/deliver', requireRole(...FOOD_ORDER_STAFF), idParams, async (req, res) => {
    res.json({ success: true, data: await orders.deliver(idOf(req)) });
  });

  router.post(
    '/:id/cancel',
    requireRole(...FOOD_ORDER_STAFF),
    validate({ params: idParamsSchema, body: cancelFoodOrderSchema }),
    async (req, res) => {
      const { reason } = req.validated?.body as { reason: string };
      res.json({ success: true, data: await orders.cancel(idOf(req), reason) });
    },
  );

  const base = { tag: 'Food orders', secured: true } as const;
  documentRoute({
    ...base,
    method: 'post',
    path: '/food-orders',
    summary:
      'Place an order for the guest in a room. The server prices every line from the menu; no price is accepted',
    roles: FOOD_ORDER_STAFF,
    body: createFoodOrderSchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/food-orders',
    summary: 'The order queue (open orders oldest first)',
    roles: FOOD_ORDER_STAFF,
    query: listFoodOrdersQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/food-orders/summary',
    summary: 'Counts by status and how many open orders are late',
    roles: FOOD_ORDER_STAFF,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/food-orders/:id',
    summary: 'One order',
    roles: FOOD_ORDER_STAFF,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/food-orders/:id/start',
    summary: 'Start preparing (Received to Preparing)',
    roles: COOKS,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/food-orders/:id/ready',
    summary: 'Ready to serve (Preparing to Ready)',
    roles: COOKS,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/food-orders/:id/deliver',
    summary: 'Delivered to the room (Ready to Delivered). Tells billing, once',
    roles: FOOD_ORDER_STAFF,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/food-orders/:id/cancel',
    summary: 'Cancel an order that the kitchen has not started',
    roles: FOOD_ORDER_STAFF,
    params: idParamsSchema,
    body: cancelFoodOrderSchema,
  });

  return router;
}
