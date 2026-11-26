import { MAX_MENU_IMAGE_BYTES, type MenuImageType } from '@hospitality/constants';
import type { MenuItemDto } from '@hospitality/shared-types';
import { recordAudit } from '../../shared/audit/audit';
import { HttpError, conflict, notFound } from '../../shared/errors';
import { sniffImageType } from './menu-image';
import {
  createGridFsMenuImageStorage,
  type MenuImageStorage,
  type StoredMenuImage,
} from './menu-image.storage';
import { MenuItem, type MenuItemDocument } from './menu-item.model';
import { toMenuItemDto } from './menu.mapper';

export interface MenuOptionInput {
  name: string;
  required: boolean;
  multiple: boolean;
  choices: { label: string; pricePaise: number }[];
}

export interface CreateMenuItemInput {
  name: string;
  category: string;
  description: string;
  pricePaise: number;
  options: MenuOptionInput[];
  available: boolean;
}

export type UpdateMenuItemInput = Partial<CreateMenuItemInput>;

export interface ListMenuInput {
  page: number;
  limit: number;
  category?: string | undefined;
  available?: boolean | undefined;
}

export interface MenuService {
  list(input: ListMenuInput): Promise<{ items: MenuItemDto[]; total: number }>;
  get(id: string): Promise<MenuItemDto>;
  create(input: CreateMenuItemInput): Promise<MenuItemDto>;
  update(id: string, input: UpdateMenuItemInput): Promise<MenuItemDto>;
  remove(id: string): Promise<{ id: string }>;
  /** `declaredType` is what the client said it sent; the bytes must really be that type. */
  setImage(id: string, declaredType: MenuImageType, data: Buffer): Promise<MenuItemDto>;
  getImage(id: string): Promise<StoredMenuImage>;
  removeImage(id: string): Promise<MenuItemDto>;
}

/** Names and categories compare without caring about upper or lower case. */
const CASE_INSENSITIVE = { locale: 'en', strength: 2 } as const;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

const duplicateName = (): HttpError =>
  conflict('A menu item with that name already exists', 'duplicate_item');

const unsupportedImage = (): HttpError =>
  new HttpError(415, 'unsupported_image', 'Send the image as a JPEG, PNG or WebP file');

export function createMenuService(
  storage: MenuImageStorage = createGridFsMenuImageStorage(),
): MenuService {
  async function load(id: string): Promise<MenuItemDocument> {
    const item = await MenuItem.findOne({ _id: id }).lean();
    if (!item) throw notFound('Menu item not found');
    return item;
  }

  async function audit(
    action: string,
    item: MenuItemDocument,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await recordAudit({
      action: `menu.${action}`,
      target: { type: 'menu_item', id: item._id.toHexString() },
      summary: { name: item.name, ...extra },
    });
  }

  return {
    async list(input) {
      const filter: Record<string, unknown> = {};
      if (input.category) filter.category = input.category;
      if (input.available !== undefined) filter.available = input.available;

      const [items, total] = await Promise.all([
        MenuItem.find(filter)
          .collation(CASE_INSENSITIVE)
          .sort({ category: 1, nameKey: 1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        MenuItem.countDocuments(filter).collation(CASE_INSENSITIVE),
      ]);
      return { items: items.map(toMenuItemDto), total };
    },

    async get(id) {
      return toMenuItemDto(await load(id));
    },

    async create(input) {
      let item: MenuItemDocument;
      try {
        const created = await MenuItem.create({ ...input, nameKey: input.name.toLowerCase() });
        item = created.toObject();
      } catch (error) {
        if (isDuplicateKey(error)) throw duplicateName();
        throw error;
      }
      await audit('created', item, { category: item.category, pricePaise: item.pricePaise });
      return toMenuItemDto(item);
    },

    async update(id, input) {
      const before = await load(id);
      const changes: Record<string, unknown> = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      );
      if (input.name !== undefined) changes.nameKey = input.name.toLowerCase();

      let updated: MenuItemDocument | null;
      try {
        updated = await MenuItem.findOneAndUpdate(
          { _id: id },
          { $set: changes },
          { returnDocument: 'after', runValidators: true },
        ).lean();
      } catch (error) {
        if (isDuplicateKey(error)) throw duplicateName();
        throw error;
      }
      if (!updated) throw notFound('Menu item not found');

      await audit('updated', updated, {
        fields: Object.keys(input).filter(
          (key) => input[key as keyof UpdateMenuItemInput] !== undefined,
        ),
        ...(updated.pricePaise !== before.pricePaise
          ? { previousPricePaise: before.pricePaise, pricePaise: updated.pricePaise }
          : {}),
      });
      return toMenuItemDto(updated);
    },

    async remove(id) {
      const item = await load(id);
      // The file goes first. If deleting the item then fails, the item is merely left pointing at
      // a missing file and the delete can be repeated; the other way round would orphan a file.
      if (item.imageId) await storage.remove(item.imageId);
      const deleted = await MenuItem.findOneAndDelete({ _id: id }).lean();
      if (!deleted) throw notFound('Menu item not found');
      await audit('deleted', deleted);
      return { id };
    },

    async setImage(id, declaredType, data) {
      const item = await load(id);
      const realType = sniffImageType(data);
      if (!realType || realType !== declaredType) throw unsupportedImage();
      if (data.length > MAX_MENU_IMAGE_BYTES) {
        throw new HttpError(413, 'payload_too_large', 'Request body is too large');
      }

      const fileId = await storage.save({
        propertyId: item.propertyId,
        menuItemId: id,
        contentType: realType,
        data,
      });
      let updated: MenuItemDocument | null;
      try {
        updated = await MenuItem.findOneAndUpdate(
          { _id: id },
          { $set: { imageId: fileId, imageType: realType } },
          { returnDocument: 'after' },
        ).lean();
      } catch (error) {
        await storage.remove(fileId);
        throw error;
      }
      if (!updated) {
        // The item was deleted while the file was uploading.
        await storage.remove(fileId);
        throw notFound('Menu item not found');
      }
      if (item.imageId) await storage.remove(item.imageId);
      await audit('image_set', updated, { contentType: realType, bytes: data.length });
      return toMenuItemDto(updated);
    },

    async getImage(id) {
      const item = await load(id);
      const stored = item.imageId ? await storage.open(item.propertyId, item.imageId) : null;
      if (!stored) throw notFound('This item has no image', 'no_image');
      return stored;
    },

    async removeImage(id) {
      const item = await load(id);
      if (!item.imageId) return toMenuItemDto(item);
      await storage.remove(item.imageId);
      const updated = await MenuItem.findOneAndUpdate(
        { _id: id },
        { $set: { imageId: null, imageType: null } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) throw notFound('Menu item not found');
      await audit('image_removed', updated);
      return toMenuItemDto(updated);
    },
  };
}
