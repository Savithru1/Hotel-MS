import {
  FOOD_ORDER_OPEN_STATUSES,
  SLA_MINUTES,
  type HousekeepingStatus,
  type MaintenanceStatus,
  type NotificationLinkKind,
} from '@hospitality/constants';
import type { Model, QueryFilter, Types } from 'mongoose';
import { FoodOrder } from '../../modules/food-orders/food-order.model';
import { MaintenanceIssue } from '../../modules/maintenance/maintenance.model';
import { managersOf } from '../../modules/notifications/managers';
import type { NotificationService } from '../../modules/notifications/notification.service';
import { Room } from '../../modules/rooms/room.model';
import { ServiceRequest } from '../../modules/service-requests/service-request.model';
import type { Clock, JobHandler } from '../worker';

/** At most this many items are looked at per source per run; the next run does the rest. */
const BATCH_LIMIT = 200;
const MINUTE_MS = 60_000;

const HOUSEKEEPING_OPEN: HousekeepingStatus[] = ['new', 'in_progress'];
const MAINTENANCE_OPEN: MaintenanceStatus[] = ['new', 'assigned', 'in_progress'];

/** One open item that has waited longer than its limit and has not been reminded about yet. */
interface Overdue {
  id: Types.ObjectId;
  roomLabel: string;
  createdAt: Date;
  limitMinutes: number;
}

interface Source {
  kind: NotificationLinkKind;
  label: string;
  /** Statuses in which an item still counts as open. */
  open: readonly string[];
  model: Model<{ slaRemindedAt: Date | null }>;
  find(now: Date): Promise<Overdue[]>;
}

const cutoff = (now: Date, minutes: number): Date => new Date(now.getTime() - minutes * MINUTE_MS);

async function roomNumbers(roomIds: Types.ObjectId[]): Promise<Map<string, string>> {
  if (roomIds.length === 0) return new Map();
  const rooms = await Room.find({ _id: { $in: roomIds } }, { number: 1 }).lean();
  return new Map(rooms.map((room) => [room._id.toHexString(), room.number]));
}

const roomLabel = (numbers: Map<string, string>, roomId: Types.ObjectId): string =>
  numbers.get(roomId.toHexString()) ?? '?';

const housekeepingSource: Source = {
  kind: 'housekeeping',
  label: 'housekeeping request',
  open: HOUSEKEEPING_OPEN,
  model: ServiceRequest as unknown as Source['model'],
  async find(now) {
    const limits = SLA_MINUTES.housekeeping;
    const items = await ServiceRequest.find({
      status: { $in: HOUSEKEEPING_OPEN },
      slaRemindedAt: null,
      $or: (Object.keys(limits) as (keyof typeof limits)[]).map((priority) => ({
        priority,
        createdAt: { $lt: cutoff(now, limits[priority]) },
      })),
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_LIMIT)
      .lean();
    const numbers = await roomNumbers(items.map((item) => item.roomId));
    return items.map((item) => ({
      id: item._id,
      roomLabel: roomLabel(numbers, item.roomId),
      createdAt: item.createdAt,
      limitMinutes: limits[item.priority],
    }));
  },
};

const maintenanceSource: Source = {
  kind: 'maintenance',
  label: 'maintenance issue',
  open: MAINTENANCE_OPEN,
  model: MaintenanceIssue as unknown as Source['model'],
  async find(now) {
    const limits = SLA_MINUTES.maintenance;
    const items = await MaintenanceIssue.find({
      status: { $in: MAINTENANCE_OPEN },
      slaRemindedAt: null,
      $or: (Object.keys(limits) as (keyof typeof limits)[]).map((priority) => ({
        priority,
        createdAt: { $lt: cutoff(now, limits[priority]) },
      })),
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_LIMIT)
      .lean();
    const numbers = await roomNumbers(items.map((item) => item.roomId));
    return items.map((item) => ({
      id: item._id,
      roomLabel: roomLabel(numbers, item.roomId),
      createdAt: item.createdAt,
      limitMinutes: limits[item.priority],
    }));
  },
};

const foodSource: Source = {
  kind: 'food_order',
  label: 'food order',
  open: FOOD_ORDER_OPEN_STATUSES,
  model: FoodOrder as unknown as Source['model'],
  async find(now) {
    const items = await FoodOrder.find({
      status: { $in: [...FOOD_ORDER_OPEN_STATUSES] },
      slaRemindedAt: null,
      createdAt: { $lt: cutoff(now, SLA_MINUTES.food) },
    })
      .sort({ createdAt: 1 })
      .limit(BATCH_LIMIT)
      .lean();
    return items.map((item) => ({
      id: item._id,
      roomLabel: item.roomNumber,
      createdAt: item.createdAt,
      limitMinutes: SLA_MINUTES.food,
    }));
  },
};

const SOURCES: readonly Source[] = [housekeepingSource, maintenanceSource, foodSource];

export interface SlaScanOptions {
  clock: Clock;
  notifications: Pick<NotificationService, 'notify'>;
}

/**
 * Looks for open work that has waited longer than its limit and reminds managers once.
 *
 * Each item is claimed with a conditional update (`slaRemindedAt` still empty, still open), so
 * when several scans overlap only the one that wins the claim sends the reminder. If sending
 * fails the claim is given back, so the next scan tries again. Runs inside one property.
 */
export function createSlaScanHandler({ clock, notifications }: SlaScanOptions): JobHandler {
  async function claim(source: Source, id: Types.ObjectId, now: Date): Promise<boolean> {
    const filter = {
      _id: id,
      slaRemindedAt: null,
      status: { $in: [...source.open] },
    } as QueryFilter<{ slaRemindedAt: Date | null }>;
    const won = await source.model
      .findOneAndUpdate(filter, { $set: { slaRemindedAt: now } }, { returnDocument: 'after' })
      .lean();
    return won !== null;
  }

  async function release(source: Source, id: Types.ObjectId, now: Date): Promise<void> {
    await source.model.updateOne(
      { _id: id, slaRemindedAt: now },
      { $set: { slaRemindedAt: null } },
    );
  }

  async function remind(
    source: Source,
    item: Overdue,
    managers: string[],
    now: Date,
  ): Promise<void> {
    const minutes = Math.round((now.getTime() - item.createdAt.getTime()) / MINUTE_MS);
    await notifications.notify({
      recipientIds: managers,
      type: 'sla_breach',
      title: `Room ${item.roomLabel}: ${source.label} overdue`,
      body: `Open for ${minutes} minutes. The target is ${item.limitMinutes} minutes.`,
      link: { kind: source.kind, id: item.id.toHexString() },
      dedupeKey: `sla:${source.kind}:${item.id.toHexString()}`,
    });
  }

  async function scanSource(source: Source, managers: string[], now: Date): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const item of await source.find(now)) {
      if (!(await claim(source, item.id, now))) continue;
      try {
        await remind(source, item, managers, now);
      } catch (error) {
        failures.push(error);
        await release(source, item.id, now);
      }
    }
    return failures;
  }

  return async (job) => {
    const now = clock.now();
    const managers = await managersOf(job.propertyId);
    // Nobody to tell: leave everything unclaimed so a later scan can still remind.
    if (managers.length === 0) return;

    const failures: unknown[] = [];
    for (const source of SOURCES) failures.push(...(await scanSource(source, managers, now)));
    if (failures.length > 0) throw failures[0];
  };
}
