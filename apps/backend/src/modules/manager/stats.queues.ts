import {
  FACILITY_HOLDING_STATUSES,
  FOOD_ORDER_OPEN_STATUSES,
  type HousekeepingStatus,
  type MaintenanceStatus,
} from '@hospitality/constants';
import type {
  OverviewDto,
  OverviewEscalationDto,
  QueueOverviewDto,
} from '@hospitality/shared-types';
import type { Types } from 'mongoose';
import { FacilityBooking } from '../facilities/facility-booking.model';
import { FoodOrder } from '../food-orders/food-order.model';
import { MaintenanceIssue } from '../maintenance/maintenance.model';
import { Room } from '../rooms/room.model';
import { ServiceRequest } from '../service-requests/service-request.model';

const HOUSEKEEPING_OPEN: HousekeepingStatus[] = ['new', 'in_progress'];
const MAINTENANCE_OPEN: MaintenanceStatus[] = ['new', 'assigned', 'in_progress'];
/** The most escalations the overview lists; a manager with more than this has bigger problems. */
const ESCALATION_LIMIT = 50;

/** The instants a local day covers: `start` is included, `end` (midnight after) is not. */
export interface DayBounds {
  start: Date;
  end: Date;
}

const within = ({ start, end }: DayBounds): { $gte: Date; $lt: Date } => ({
  $gte: start,
  $lt: end,
});

async function housekeepingQueue(day: DayBounds): Promise<QueueOverviewDto> {
  const open = { status: { $in: HOUSEKEEPING_OPEN } };
  const [pending, completedToday, escalated, urgent] = await Promise.all([
    ServiceRequest.countDocuments(open),
    ServiceRequest.countDocuments({ status: 'completed', completedAt: within(day) }),
    ServiceRequest.countDocuments({ ...open, escalated: true }),
    ServiceRequest.countDocuments({ ...open, priority: 'urgent' }),
  ]);
  return { pending, completedToday, escalated, urgent };
}

async function maintenanceQueue(day: DayBounds): Promise<QueueOverviewDto> {
  const open = { status: { $in: MAINTENANCE_OPEN } };
  const [pending, completedToday, escalated, urgent] = await Promise.all([
    MaintenanceIssue.countDocuments(open),
    MaintenanceIssue.countDocuments({ status: 'resolved', resolvedAt: within(day) }),
    MaintenanceIssue.countDocuments({ ...open, escalated: true }),
    MaintenanceIssue.countDocuments({ ...open, priority: 'urgent' }),
  ]);
  return { pending, completedToday, escalated, urgent };
}

/** Kitchen orders cannot be escalated or marked urgent, so those two figures are always 0. */
async function kitchenQueue(day: DayBounds): Promise<QueueOverviewDto> {
  const [pending, completedToday] = await Promise.all([
    FoodOrder.countDocuments({ status: { $in: [...FOOD_ORDER_OPEN_STATUSES] } }),
    FoodOrder.countDocuments({ status: 'delivered', deliveredAt: within(day) }),
  ]);
  return { pending, completedToday, escalated: 0, urgent: 0 };
}

/** Spa and recreation bookings cannot be escalated or marked urgent, so those figures are 0. */
async function spaQueue(day: DayBounds): Promise<QueueOverviewDto> {
  const [pending, completedToday] = await Promise.all([
    FacilityBooking.countDocuments({ status: { $in: [...FACILITY_HOLDING_STATUSES] } }),
    FacilityBooking.countDocuments({ status: 'completed', completedAt: within(day) }),
  ]);
  return { pending, completedToday, escalated: 0, urgent: 0 };
}

export async function queuesFor(day: DayBounds): Promise<OverviewDto['queues']> {
  const [housekeeping, maintenance, kitchen, spa] = await Promise.all([
    housekeepingQueue(day),
    maintenanceQueue(day),
    kitchenQueue(day),
    spaQueue(day),
  ]);
  return { housekeeping, maintenance, kitchen, spa };
}

interface EscalatedItem {
  _id: Types.ObjectId;
  roomId: Types.ObjectId;
  escalationReason: string | null;
  escalatedAt: Date | null;
  priority: string;
}

const byNewest = (left: OverviewEscalationDto, right: OverviewEscalationDto): number =>
  (right.escalatedAt ?? '').localeCompare(left.escalatedAt ?? '');

/** Work that someone escalated and that is still open, newest escalation first. */
export async function openEscalations(): Promise<OverviewEscalationDto[]> {
  const fields = { roomId: 1, escalationReason: 1, escalatedAt: 1, priority: 1 };
  const [requests, issues] = await Promise.all([
    ServiceRequest.find({ status: { $in: HOUSEKEEPING_OPEN }, escalated: true }, fields)
      .sort({ escalatedAt: -1 })
      .limit(ESCALATION_LIMIT)
      .lean<EscalatedItem[]>(),
    MaintenanceIssue.find({ status: { $in: MAINTENANCE_OPEN }, escalated: true }, fields)
      .sort({ escalatedAt: -1 })
      .limit(ESCALATION_LIMIT)
      .lean<EscalatedItem[]>(),
  ]);
  const roomIds = [...new Set([...requests, ...issues].map((item) => item.roomId))];
  const rooms =
    roomIds.length === 0 ? [] : await Room.find({ _id: { $in: roomIds } }, { number: 1 }).lean();
  const numbers = new Map(rooms.map((room) => [room._id.toHexString(), room.number]));

  const toDto = (
    kind: OverviewEscalationDto['kind'],
    item: EscalatedItem,
  ): OverviewEscalationDto => ({
    kind,
    id: item._id.toHexString(),
    roomNumber: numbers.get(item.roomId.toHexString()) ?? null,
    reason: item.escalationReason,
    escalatedAt: item.escalatedAt ? item.escalatedAt.toISOString() : null,
    priority: item.priority,
  });
  return [
    ...requests.map((item) => toDto('housekeeping', item)),
    ...issues.map((item) => toDto('maintenance', item)),
  ]
    .sort(byNewest)
    .slice(0, ESCALATION_LIMIT);
}
