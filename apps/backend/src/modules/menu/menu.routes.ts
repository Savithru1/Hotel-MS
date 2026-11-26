import { MAX_MENU_IMAGE_BYTES, MENU_IMAGE_TYPES, type MenuImageType } from '@hospitality/constants';
import {
  createMenuItemSchema,
  idParamsSchema,
  listMenuQuerySchema,
  updateMenuItemSchema,
} from '@hospitality/validation';
import express, { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { MANAGEMENT, requireRole } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { HttpError } from '../../shared/errors';
import { documentRoute } from '../../shared/openapi';
import type { AuthService } from '../auth/auth.service';
import type { TokenService } from '../auth/token.service';
import type {
  CreateMenuItemInput,
  ListMenuInput,
  MenuService,
  UpdateMenuItemInput,
} from './menu.service';

/** Who can read the menu: the people who place and cook orders, and management. */
export const MENU_VIEWERS = ['kitchen', 'front_desk', ...MANAGEMENT] as const;

const IMAGE_CACHE_SECONDS = 300;

export function menuRouter(tokens: TokenService, auth: AuthService, menu: MenuService): Router {
  const router = Router();
  router.use(authenticate(tokens, auth));
  const idParams = validate({ params: idParamsSchema });
  const idOf = (req: { validated?: { params?: unknown } }): string =>
    (req.validated?.params as { id: string }).id;

  router.get(
    '/items',
    requireRole(...MENU_VIEWERS),
    validate({ query: listMenuQuerySchema }),
    async (req, res) => {
      const query = req.validated?.query as ListMenuInput;
      const { items, total } = await menu.list(query);
      res.json({
        success: true,
        data: items,
        meta: { total, page: query.page, limit: query.limit },
      });
    },
  );

  router.post(
    '/items',
    requireRole(...MANAGEMENT),
    validate({ body: createMenuItemSchema }),
    async (req, res) => {
      const created = await menu.create(req.validated?.body as CreateMenuItemInput);
      res.status(201).json({ success: true, data: created });
    },
  );

  router.get('/items/:id', requireRole(...MENU_VIEWERS), idParams, async (req, res) => {
    res.json({ success: true, data: await menu.get(idOf(req)) });
  });

  router.patch(
    '/items/:id',
    requireRole(...MANAGEMENT),
    validate({ params: idParamsSchema, body: updateMenuItemSchema }),
    async (req, res) => {
      const updated = await menu.update(idOf(req), req.validated?.body as UpdateMenuItemInput);
      res.json({ success: true, data: updated });
    },
  );

  router.delete('/items/:id', requireRole(...MANAGEMENT), idParams, async (req, res) => {
    res.json({ success: true, data: await menu.remove(idOf(req)) });
  });

  // The role check comes before the body is read, so only management can make the server buffer
  // an upload. Only the three image types are read at all; anything else leaves the body empty.
  router.put(
    '/items/:id/image',
    requireRole(...MANAGEMENT),
    idParams,
    express.raw({ type: [...MENU_IMAGE_TYPES], limit: MAX_MENU_IMAGE_BYTES }),
    async (req, res) => {
      const declared = req.is([...MENU_IMAGE_TYPES]);
      const body: unknown = req.body;
      if (!declared || !Buffer.isBuffer(body) || body.length === 0) {
        throw new HttpError(415, 'unsupported_image', 'Send the image as a JPEG, PNG or WebP file');
      }
      const updated = await menu.setImage(idOf(req), declared as MenuImageType, body);
      res.json({ success: true, data: updated });
    },
  );

  router.get('/items/:id/image', requireRole(...MENU_VIEWERS), idParams, async (req, res) => {
    const image = await menu.getImage(idOf(req));
    res.status(200);
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', String(image.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // An image needs no scripts, styles or frames. This makes sure none can run even if a crafted
    // file passed the byte check, and it replaces the app-wide policy for this response only.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // Private: the image is behind sign-in, so shared caches must not keep a copy.
    res.setHeader('Cache-Control', `private, max-age=${IMAGE_CACHE_SECONDS}`);
    image.stream.on('error', (error) => res.destroy(error));
    image.stream.pipe(res);
  });

  router.delete('/items/:id/image', requireRole(...MANAGEMENT), idParams, async (req, res) => {
    res.json({ success: true, data: await menu.removeImage(idOf(req)) });
  });

  const base = { tag: 'Menu', secured: true } as const;
  documentRoute({
    ...base,
    method: 'get',
    path: '/menu/items',
    summary: 'The menu, by category then name',
    roles: MENU_VIEWERS,
    query: listMenuQuerySchema,
  });
  documentRoute({
    ...base,
    method: 'post',
    path: '/menu/items',
    summary: 'Add a menu item',
    roles: MANAGEMENT,
    body: createMenuItemSchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/menu/items/:id',
    summary: 'One menu item',
    roles: MENU_VIEWERS,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'patch',
    path: '/menu/items/:id',
    summary: 'Change a menu item, including switching it available or sold out',
    roles: MANAGEMENT,
    params: idParamsSchema,
    body: updateMenuItemSchema,
  });
  documentRoute({
    ...base,
    method: 'delete',
    path: '/menu/items/:id',
    summary: 'Remove a menu item and its image. Orders already placed keep their copy',
    roles: MANAGEMENT,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'put',
    path: '/menu/items/:id/image',
    summary:
      'Upload the image as the raw request body (JPEG, PNG or WebP, up to 2 MB). The bytes are checked',
    roles: MANAGEMENT,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'get',
    path: '/menu/items/:id/image',
    summary: 'The image of a menu item',
    roles: MENU_VIEWERS,
    params: idParamsSchema,
  });
  documentRoute({
    ...base,
    method: 'delete',
    path: '/menu/items/:id/image',
    summary: 'Remove the image of a menu item',
    roles: MANAGEMENT,
    params: idParamsSchema,
  });

  return router;
}
