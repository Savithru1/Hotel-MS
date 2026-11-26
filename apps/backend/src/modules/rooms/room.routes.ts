import {
  createRoomSchema,
  createRoomTypeSchema,
  idParamsSchema,
  listRoomsQuerySchema,
  setRoomStatusSchema,
  updateRoomSchema,
  updateRoomTypeSchema,
} from '@hospitality/validation';
import type { RoomStatus } from '@hospitality/constants';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type {
  CreateRoomInput,
  CreateRoomTypeInput,
  ListRoomsInput,
  RoomService,
  UpdateRoomInput,
  UpdateRoomTypeInput,
} from './room.service';

const ROOM_STATUS_EDITORS = ['front_desk', ...MANAGEMENT] as const;

/** Routes for `/room-types` and `/rooms`. */
export function roomRouters(
  tokens: TokenService,
  auth: AuthService,
  rooms: RoomService,
): { roomTypes: Router; rooms: Router } {
  const mustSignIn = authenticate(tokens, auth);

  // Room types ---------------------------------------------------------------------------
  const roomTypes = Router();
  roomTypes.use(mustSignIn);
  roomTypes.get('/', async (_req, res) => {
    res.json({ success: true, data: await rooms.listTypes() });
  });
  roomTypes.post(
    '/',
    requireRole(...MANAGEMENT),
    validate({ body: createRoomTypeSchema }),
    async (req, res) => {
      const created = await rooms.createType(req.validated?.body as CreateRoomTypeInput);
      res.status(201).json({ success: true, data: created });
    },
  );
  roomTypes.patch(
    '/:id',
    requireRole(...MANAGEMENT),
    validate({ params: idParamsSchema, body: updateRoomTypeSchema }),
    async (req, res) => {
      const { id } = req.validated?.params as { id: string };
      const updated = await rooms.updateType(id, req.validated?.body as UpdateRoomTypeInput);
      res.json({ success: true, data: updated });
    },
  );

  // Rooms --------------------------------------------------------------------------------
  const roomRouter = Router();
  roomRouter.use(mustSignIn);
  roomRouter.get('/', validate({ query: listRoomsQuerySchema }), async (req, res) => {
    const query = req.validated?.query as ListRoomsInput;
    const { items, total } = await rooms.list(query);
    res.json({ success: true, data: items, meta: { total, page: query.page, limit: query.limit } });
  });
  roomRouter.get('/:id', validate({ params: idParamsSchema }), async (req, res) => {
    const { id } = req.validated?.params as { id: string };
    res.json({ success: true, data: await rooms.get(id) });
  });
  roomRouter.post(
    '/',
    requireRole(...MANAGEMENT),
    validate({ body: createRoomSchema }),
    async (req, res) => {
      const created = await rooms.create(req.validated?.body as CreateRoomInput);
      res.status(201).json({ success: true, data: created });
    },
  );
  roomRouter.patch(
    '/:id',
    requireRole(...MANAGEMENT),
    validate({ params: idParamsSchema, body: updateRoomSchema }),
    async (req, res) => {
      const { id } = req.validated?.params as { id: string };
      const updated = await rooms.update(id, req.validated?.body as UpdateRoomInput);
      res.json({ success: true, data: updated });
    },
  );
  roomRouter.post(
    '/:id/status',
    requireRole(...ROOM_STATUS_EDITORS),
    validate({ params: idParamsSchema, body: setRoomStatusSchema }),
    async (req, res) => {
      const { id } = req.validated?.params as { id: string };
      const { status, note } = req.validated?.body as { status: RoomStatus; note?: string };
      res.json({ success: true, data: await rooms.changeStatus(id, status, { note }) });
    },
  );

  const secured = { secured: true } as const;
  documentRoute({
    ...secured,
    method: 'get',
    path: '/room-types',
    tag: 'Rooms',
    summary: 'List room types',
  });
  documentRoute({
    ...secured,
    method: 'post',
    path: '/room-types',
    tag: 'Rooms',
    summary: 'Create a room type',
    roles: MANAGEMENT,
    body: createRoomTypeSchema,
  });
  documentRoute({
    ...secured,
    method: 'patch',
    path: '/room-types/:id',
    tag: 'Rooms',
    summary: 'Change a room type',
    roles: MANAGEMENT,
    params: idParamsSchema,
    body: updateRoomTypeSchema,
  });
  documentRoute({
    ...secured,
    method: 'get',
    path: '/rooms',
    tag: 'Rooms',
    summary: 'List rooms',
    query: listRoomsQuerySchema,
  });
  documentRoute({
    ...secured,
    method: 'get',
    path: '/rooms/:id',
    tag: 'Rooms',
    summary: 'Get a room',
    params: idParamsSchema,
  });
  documentRoute({
    ...secured,
    method: 'post',
    path: '/rooms',
    tag: 'Rooms',
    summary: 'Create a room',
    roles: MANAGEMENT,
    body: createRoomSchema,
  });
  documentRoute({
    ...secured,
    method: 'patch',
    path: '/rooms/:id',
    tag: 'Rooms',
    summary: 'Change a room',
    roles: MANAGEMENT,
    params: idParamsSchema,
    body: updateRoomSchema,
  });
  documentRoute({
    ...secured,
    method: 'post',
    path: '/rooms/:id/status',
    tag: 'Rooms',
    summary: 'Set a room available, cleaning or out of service',
    roles: ROOM_STATUS_EDITORS,
    params: idParamsSchema,
    body: setRoomStatusSchema,
  });

  return { roomTypes, rooms: roomRouter };
}
