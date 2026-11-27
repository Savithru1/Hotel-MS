import {
  NOTIFICATION_LINK_KINDS,
  NOTIFICATION_TYPES,
  type NotificationLinkKind,
  type NotificationType,
} from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export const NOTIFICATION_TITLE_MAX = 120;
export const NOTIFICATION_BODY_MAX = 300;

export interface NotificationDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  /** One document per person: a group notification is fanned out when it is written. */
  recipient: { kind: 'staff'; id: Types.ObjectId };
  type: NotificationType;
  title: string;
  body: string;
  /** Ids only. The screen fetches the record itself, so authorisation stays on the REST API. */
  link: { kind: NotificationLinkKind; id: string };
  /** Stops the same event notifying the same person twice (see the unique index below). */
  dedupeKey: string;
  readAt: Date | null;
  /** Set to `readAt` + 30 days when read; the TTL index then removes it. Null while unread. */
  expireAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<NotificationDocument>(
  {
    recipient: {
      kind: { type: String, enum: ['staff'], default: 'staff', required: true },
      id: { type: Schema.Types.ObjectId, ref: 'Staff', required: true },
    },
    type: { type: String, enum: [...NOTIFICATION_TYPES], required: true },
    title: { type: String, required: true, trim: true, maxlength: NOTIFICATION_TITLE_MAX },
    body: { type: String, default: '', trim: true, maxlength: NOTIFICATION_BODY_MAX },
    link: {
      kind: { type: String, enum: [...NOTIFICATION_LINK_KINDS], required: true },
      id: { type: String, required: true, maxlength: 64 },
    },
    dedupeKey: { type: String, required: true, maxlength: 200 },
    readAt: { type: Date, default: null },
    expireAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationSchema.plugin(tenantPlugin);
notificationSchema.index({ propertyId: 1, 'recipient.id': 1, readAt: 1, createdAt: -1 });
notificationSchema.index(
  { propertyId: 1, 'recipient.id': 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);
// Read notifications disappear 30 days after they were read. Unread ones are removed by the
// cleanup job. MongoDB's TTL monitor ignores documents where `expireAt` is null.
notificationSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const Notification =
  (mongoose.models.Notification as mongoose.Model<NotificationDocument> | undefined) ??
  mongoose.model<NotificationDocument>('Notification', notificationSchema, 'notifications');
