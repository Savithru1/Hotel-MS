import type { MenuImageType } from '@hospitality/constants';
import mongoose, { type Types } from 'mongoose';
import type { Readable } from 'node:stream';
import { isMenuImageType } from './menu-image';

export interface StoredMenuImage {
  stream: Readable;
  length: number;
  contentType: MenuImageType;
}

/**
 * Where menu images are kept. The service only talks to this interface, so images could move
 * somewhere else later (an object store) without touching the menu code.
 */
export interface MenuImageStorage {
  save(input: {
    propertyId: Types.ObjectId;
    menuItemId: string;
    contentType: MenuImageType;
    data: Buffer;
  }): Promise<Types.ObjectId>;
  /** Null when the file is missing or belongs to a different property. */
  open(propertyId: Types.ObjectId, fileId: Types.ObjectId): Promise<StoredMenuImage | null>;
  /** Removing a file that is already gone is not an error. */
  remove(fileId: Types.ObjectId): Promise<void>;
}

const BUCKET_NAME = 'menu_images';

type Bucket = InstanceType<typeof mongoose.mongo.GridFSBucket>;

function bucket(): Bucket {
  const db = mongoose.connection.db;
  if (!db) throw new Error('The database is not connected');
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET_NAME });
}

/**
 * Images live in GridFS inside MongoDB (the only store this project uses). GridFS files are not
 * covered by the tenant plugin, so every file is tagged with its property and `open` only returns
 * a file that carries the property it is asked for. Callers also reach a file only through a menu
 * item they loaded through the tenant-scoped model.
 */
export function createGridFsMenuImageStorage(): MenuImageStorage {
  return {
    async save({ propertyId, menuItemId, contentType, data }) {
      const upload = bucket().openUploadStream(`menu-${menuItemId}`, {
        metadata: { propertyId, menuItemId, contentType },
      });
      await new Promise<void>((resolve, reject) => {
        upload.once('error', reject);
        upload.once('finish', () => resolve());
        upload.end(data);
      });
      return upload.id as Types.ObjectId;
    },

    async open(propertyId, fileId) {
      const files = bucket();
      const [file] = await files
        .find({ _id: fileId, 'metadata.propertyId': propertyId }, { limit: 1 })
        .toArray();
      const contentType: unknown = file?.metadata?.contentType;
      if (!file || !isMenuImageType(contentType)) return null;
      return { stream: files.openDownloadStream(fileId), length: file.length, contentType };
    },

    async remove(fileId) {
      try {
        await bucket().delete(fileId);
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith('FileNotFound'))) throw error;
      }
    },
  };
}
