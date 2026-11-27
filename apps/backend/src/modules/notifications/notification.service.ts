import {
  NOTIFICATION_READ_RETENTION_DAYS,
  NOTIFICATION_UNREAD_RETENTION_DAYS,
  type NotificationLinkKind,
  type NotificationType,
} from '@hospitality/constants';
import type { NotificationDto } from '@hospitality/shared-types';
import { Types } from 'mongoose';
import { notFound } from '../../shared/errors';
import { eventBus, type EventBus } from '../../shared/events/event-bus';
import { getTenantId } from '../../shared/request-context';
import { TenantContextError } from '../../shared/tenant-plugin';
import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
  Notification,
  type NotificationDocument,
} from './notification.model';

const DAY_MS = 86_400_000;
const DUPLICATE_KEY = 11000;

export interface NotifyInput {
  /** Staff ids. Each one gets their own notification. */
  recipientIds: readonly string[];
  type: NotificationType;
  title: string;
  body: string;
  link: { kind: NotificationLinkKind; id: string };
  /** The same key for the same person is stored once, however often it is sent. */
  dedupeKey: string;
}

export interface ListNotificationsInput {
  page: number;
  limit: number;
  unread?: boolean | undefined;
}

/**
 * Every method runs inside a property (a request, or a job or listener that set one up) and
 * only ever sees that property's notifications. Methods that act for one person take their id
 * from the verified token, never from the client.
 */
export interface NotificationService {
  /** Returns the ids of the people who got a new notification (not those who already had it). */
  notify(input: NotifyInput): Promise<Types.ObjectId[]>;
  listForStaff(
    staffId: Types.ObjectId,
    input: ListNotificationsInput,
  ): Promise<{ items: NotificationDto[]; total: number }>;
  unreadCount(staffId: Types.ObjectId): Promise<number>;
  markRead(staffId: Types.ObjectId, id: string): Promise<NotificationDto>;
  markAllRead(staffId: Types.ObjectId): Promise<number>;
  /** Removes unread notifications older than 90 days. Returns how many were removed. */
  purgeOld(now?: Date): Promise<number>;
}

const clip = (text: string, max: number): string => text.trim().slice(0, max);

export function toNotificationDto(doc: NotificationDocument): NotificationDto {
  return {
    id: doc._id.toHexString(),
    type: doc.type,
    title: doc.title,
    body: doc.body,
    link: { kind: doc.link.kind, id: doc.link.id },
    readAt: doc.readAt ? doc.readAt.toISOString() : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === DUPLICATE_KEY;
}

export function createNotificationService(bus: EventBus = eventBus): NotificationService {
  /** Stores one notification. Returns false when this person already has it. */
  async function insertOne(input: NotifyInput, recipientId: Types.ObjectId): Promise<boolean> {
    try {
      await Notification.create({
        recipient: { kind: 'staff', id: recipientId },
        type: input.type,
        title: clip(input.title, NOTIFICATION_TITLE_MAX),
        body: clip(input.body, NOTIFICATION_BODY_MAX),
        link: input.link,
        dedupeKey: input.dedupeKey,
      });
      return true;
    } catch (error) {
      // The unique index is the dedupe: a repeat is expected and is not a failure.
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  const readFilter = (staffId: Types.ObjectId) => ({ 'recipient.id': staffId });

  function readUpdate(now: Date): { readAt: Date; expireAt: Date } {
    return {
      readAt: now,
      expireAt: new Date(now.getTime() + NOTIFICATION_READ_RETENTION_DAYS * DAY_MS),
    };
  }

  return {
    async notify(input) {
      const propertyId = getTenantId();
      if (!propertyId) throw new TenantContextError('notify');
      const unique = [...new Set(input.recipientIds)].map((id) => new Types.ObjectId(id));
      if (unique.length === 0) return [];

      const results = await Promise.all(unique.map((id) => insertOne(input, id)));
      const created = unique.filter((_, index) => results[index]);
      if (created.length > 0) {
        bus.emit({
          type: 'notification.created',
          propertyId,
          audience: { managers: false, staffIds: created.map((id) => id.toHexString()) },
          data: { type: input.type, linkKind: input.link.kind },
        });
      }
      return created;
    },

    async listForStaff(staffId, input) {
      const filter: Record<string, unknown> = readFilter(staffId);
      if (input.unread === true) filter.readAt = null;
      if (input.unread === false) filter.readAt = { $ne: null };
      const [items, total] = await Promise.all([
        Notification.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        Notification.countDocuments(filter),
      ]);
      return { items: items.map(toNotificationDto), total };
    },

    unreadCount(staffId) {
      return Notification.countDocuments({ ...readFilter(staffId), readAt: null });
    },

    async markRead(staffId, id) {
      const updated = await Notification.findOneAndUpdate(
        { _id: id, ...readFilter(staffId), readAt: null },
        { $set: readUpdate(new Date()) },
        { returnDocument: 'after' },
      ).lean();
      if (updated) return toNotificationDto(updated);

      // Already read (fine, repeat the answer) or not mine / not there (404, same for both).
      const existing = await Notification.findOne({ _id: id, ...readFilter(staffId) }).lean();
      if (!existing) throw notFound('Notification not found');
      return toNotificationDto(existing);
    },

    async markAllRead(staffId) {
      const result = await Notification.updateMany(
        { ...readFilter(staffId), readAt: null },
        { $set: readUpdate(new Date()) },
      );
      return result.modifiedCount;
    },

    async purgeOld(now = new Date()) {
      const cutoff = new Date(now.getTime() - NOTIFICATION_UNREAD_RETENTION_DAYS * DAY_MS);
      const result = await Notification.deleteMany({ readAt: null, createdAt: { $lt: cutoff } });
      return result.deletedCount;
    },
  };
}
