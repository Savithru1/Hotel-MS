import {
  isManagementRole,
  type MaintenanceCategory,
  type MaintenancePriority,
  type MaintenanceStatus,
} from '@hospitality/constants';
import type { MaintenanceIssueDto, QueueSummaryDto } from '@hospitality/shared-types';
import type { Types } from 'mongoose';
import { recordAudit } from '../../shared/audit/audit';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors';
import { eventBus, type EventBus } from '../../shared/events/event-bus';
import { getContext } from '../../shared/request-context';
import { transition, type HistoryEntry } from '../../shared/state-machine';
import { inTransaction } from '../../shared/transaction';
import type { AuthenticatedStaff } from '../auth/auth.types';
import { Booking } from '../bookings/booking.model';
import { Room } from '../rooms/room.model';
import { announceRoomStatus, type RoomService } from '../rooms/room.service';
import { ServiceRequest } from '../service-requests/service-request.model';
import { assertAssignable, assigneeMap } from '../staff/staff-lookup';
import {
  MaintenanceIssue,
  maintenanceMachine,
  type MaintenanceIssueDocument,
} from './maintenance.model';

export interface CreateIssueInput {
  roomId: string;
  category: MaintenanceCategory;
  description: string;
  priority: MaintenancePriority;
  takeRoomOutOfService: boolean;
}

export interface ListIssuesInput {
  page: number;
  limit: number;
  status?: string | undefined;
  roomId?: string | undefined;
  priority?: string | undefined;
  mine?: boolean | undefined;
  escalated?: boolean | undefined;
  open?: boolean | undefined;
}

export interface MaintenanceService {
  create(actor: AuthenticatedStaff, input: CreateIssueInput): Promise<MaintenanceIssueDto>;
  list(
    actor: AuthenticatedStaff,
    input: ListIssuesInput,
  ): Promise<{ items: MaintenanceIssueDto[]; total: number }>;
  get(id: string): Promise<MaintenanceIssueDto>;
  summary(): Promise<QueueSummaryDto>;
  /** Hands the issue to a technician. A technician may only take an unassigned one for themselves. */
  assign(actor: AuthenticatedStaff, id: string, staffId: string): Promise<MaintenanceIssueDto>;
  start(actor: AuthenticatedStaff, id: string): Promise<MaintenanceIssueDto>;
  resolve(actor: AuthenticatedStaff, id: string, note: string): Promise<MaintenanceIssueDto>;
  escalate(actor: AuthenticatedStaff, id: string, reason: string): Promise<MaintenanceIssueDto>;
  acknowledge(actor: AuthenticatedStaff, id: string): Promise<MaintenanceIssueDto>;
}

const OPEN: MaintenanceStatus[] = ['new', 'assigned', 'in_progress'];
const PRIORITY_RANK: Record<MaintenancePriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  urgent: 3,
};

async function toDtos(issues: MaintenanceIssueDocument[]): Promise<MaintenanceIssueDto[]> {
  if (issues.length === 0) return [];
  const [rooms, people] = await Promise.all([
    Room.find({ _id: { $in: [...new Set(issues.map((i) => i.roomId))] } }, { number: 1 }).lean(),
    assigneeMap(issues.map((i) => i.assignedTo)),
  ]);
  const numbers = new Map(rooms.map((room) => [room._id.toHexString(), room.number]));
  return issues.map((issue) => ({
    id: issue._id.toHexString(),
    category: issue.category,
    description: issue.description,
    priority: issue.priority,
    roomId: issue.roomId.toHexString(),
    roomNumber: numbers.get(issue.roomId.toHexString()) ?? null,
    bookingId: issue.bookingId ? issue.bookingId.toHexString() : null,
    takesRoomOutOfService: issue.takesRoomOutOfService,
    status: issue.status,
    assignedTo: issue.assignedTo ? (people.get(issue.assignedTo.toHexString()) ?? null) : null,
    escalated: issue.escalated,
    escalationReason: issue.escalationReason,
    resolutionNote: issue.resolutionNote,
    reportedBy: issue.reportedBy,
    createdAt: issue.createdAt.toISOString(),
    resolvedAt: issue.resolvedAt ? issue.resolvedAt.toISOString() : null,
  }));
}

async function toDto(issue: MaintenanceIssueDocument): Promise<MaintenanceIssueDto> {
  const [dto] = await toDtos([issue]);
  if (!dto) throw new Error('Could not build the issue');
  return dto;
}

export function createMaintenanceService(
  rooms: Pick<RoomService, 'changeStatus'>,
  bus: EventBus = eventBus,
): MaintenanceService {
  async function announce(issue: MaintenanceIssueDocument, change: string): Promise<void> {
    const room = await Room.findOne({ _id: issue.roomId }, { number: 1 }).lean();
    bus.emit({
      type: 'maintenance.changed',
      propertyId: issue.propertyId,
      // Housekeeping is deliberately not here: they report problems but do not see the queue.
      audience: { departments: ['maintenance', 'front_desk'] },
      data: {
        issueId: issue._id.toHexString(),
        roomId: issue.roomId.toHexString(),
        roomNumber: room?.number ?? '?',
        status: issue.status,
        change,
        escalated: issue.escalated,
        priority: issue.priority,
        assignedTo: issue.assignedTo ? issue.assignedTo.toHexString() : null,
      },
    });
  }

  async function load(id: string): Promise<MaintenanceIssueDocument> {
    const issue = await MaintenanceIssue.findOne({ _id: id }).lean();
    if (!issue) throw notFound('Issue not found');
    return issue;
  }

  const isManager = (actor: AuthenticatedStaff): boolean =>
    isManagementRole(actor.role) || actor.role === 'platform_admin';

  function assertAssignee(actor: AuthenticatedStaff, issue: MaintenanceIssueDocument): void {
    if (isManager(actor)) return;
    if (!issue.assignedTo?.equals(actor.id)) {
      throw forbidden('Only the technician it is assigned to can do this', 'not_your_issue');
    }
  }

  async function audit(action: string, issue: MaintenanceIssueDocument, extra = {}): Promise<void> {
    await recordAudit({
      action: `maintenance.${action}`,
      target: { type: 'maintenance_issue', id: issue._id.toHexString() },
      summary: { category: issue.category, roomId: issue.roomId.toHexString(), ...extra },
    });
  }

  return {
    async create(actor, input) {
      const room = await Room.findOne({ _id: input.roomId, active: true }).lean();
      if (!room) throw badRequest('That room does not exist', 'unknown_room');
      const booking = await Booking.findOne(
        { roomId: room._id, status: 'checked_in' },
        { _id: 1 },
      ).lean();

      if (input.takeRoomOutOfService && ['occupied', 'reserved'].includes(room.status)) {
        throw conflict(
          `Room ${room.number} has a guest in it or due in. Report the problem without taking the room out of service.`,
          'room_occupied',
        );
      }

      const principal = getContext()?.principal;
      const { issue, roomChanged } = await inTransaction(async (session) => {
        const [created] = await MaintenanceIssue.create(
          [
            {
              category: input.category,
              description: input.description,
              priority: input.priority,
              priorityRank: PRIORITY_RANK[input.priority],
              roomId: room._id,
              bookingId: booking?._id ?? null,
              takesRoomOutOfService: input.takeRoomOutOfService,
              reportedBy: actor.id.toHexString(),
              history: [
                { from: null, to: 'new', at: new Date(), ...(principal ? { by: principal } : {}) },
              ],
            },
          ],
          { session },
        );
        if (!created) throw new Error('Issue was not created');

        let changed = false;
        if (input.takeRoomOutOfService && room.status !== 'maintenance') {
          // The room-state chain, in the same transaction as the issue itself.
          await rooms.changeStatus(room._id.toHexString(), 'maintenance', {
            session,
            note: `Maintenance issue: ${input.category}`,
          });
          changed = true;
        }
        return { issue: created.toObject(), roomChanged: changed };
      });

      await audit('created', issue, {
        priority: input.priority,
        outOfService: input.takeRoomOutOfService,
      });
      await announce(issue, 'created');
      if (roomChanged) {
        announceRoomStatus(
          bus,
          issue.propertyId,
          room._id,
          room.number,
          'maintenance',
          room.status,
        );
      }
      return toDto(issue);
    },

    async list(actor, input) {
      const filter: Record<string, unknown> = {};
      if (input.status) filter.status = input.status;
      if (input.roomId) filter.roomId = input.roomId;
      if (input.priority) filter.priority = input.priority;
      if (input.escalated !== undefined) filter.escalated = input.escalated;
      if (input.mine) filter.assignedTo = actor.id;
      if (input.open) filter.status = { $in: OPEN };

      const [items, total] = await Promise.all([
        MaintenanceIssue.find(filter)
          .sort({ priorityRank: -1, createdAt: 1, _id: 1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        MaintenanceIssue.countDocuments(filter),
      ]);
      return { items: await toDtos(items), total };
    },

    async get(id) {
      return toDto(await load(id));
    },

    async summary() {
      const [rows, escalated, urgent] = await Promise.all([
        MaintenanceIssue.aggregate<{ _id: string; count: number }>([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        MaintenanceIssue.countDocuments({ status: { $in: OPEN }, escalated: true }),
        MaintenanceIssue.countDocuments({ status: { $in: OPEN }, priority: 'urgent' }),
      ]);
      const byStatus: Record<string, number> = { new: 0, assigned: 0, in_progress: 0, resolved: 0 };
      for (const row of rows) byStatus[row._id] = row.count;
      return { byStatus, escalated, urgent };
    },

    async assign(actor, id, staffId) {
      const issue = await load(id);
      if (!isManager(actor)) {
        // A technician can only pick up an unassigned issue for themselves.
        if (staffId !== actor.id.toHexString() || issue.status !== 'new') {
          throw forbidden('Only a manager can assign or reassign work', 'forbidden');
        }
      }
      const person = await assertAssignable(staffId, 'maintenance');
      if (issue.status === 'resolved') {
        throw conflict('A resolved issue cannot be assigned', 'bad_transition');
      }

      const by = getContext()?.principal;
      const entry: HistoryEntry = {
        from: issue.status,
        to: 'assigned',
        at: new Date(),
        ...(by ? { by } : {}),
        note: `Assigned to ${person.name}`,
      };
      // The current status and assignee are in the filter, so two people assigning at the same
      // moment cannot both win; the loser gets a 409.
      const updated = await MaintenanceIssue.findOneAndUpdate(
        { _id: id, status: issue.status, assignedTo: issue.assignedTo },
        { $set: { status: 'assigned', assignedTo: person.id }, $push: { history: entry } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) throw conflict('Someone else changed this issue at the same time', 'conflict');
      await audit('assigned', updated, {
        assignedTo: staffId,
        previous: issue.assignedTo?.toHexString() ?? null,
      });
      await announce(updated, 'assigned');
      return toDto(updated);
    },

    async start(actor, id) {
      assertAssignee(actor, await load(id));
      const moved = await transition({
        model: MaintenanceIssue,
        id,
        machine: maintenanceMachine,
        to: 'in_progress',
      });
      const updated = moved.toObject();
      await audit('started', updated);
      await announce(updated, 'started');
      return toDto(updated);
    },

    async resolve(actor, id, note) {
      assertAssignee(actor, await load(id));
      const { updated, released } = await inTransaction(async (session) => {
        const moved = await transition({
          model: MaintenanceIssue,
          id,
          machine: maintenanceMachine,
          to: 'resolved',
          set: { resolvedAt: new Date(), resolutionNote: note, escalated: false },
          note,
          session,
        });

        // Release the room, but only if no other open issue is still keeping it out of service.
        let freed: { roomId: Types.ObjectId; roomNumber: string; status: string } | null = null;
        if (moved.takesRoomOutOfService) {
          const stillBlocked = await MaintenanceIssue.exists({
            _id: { $ne: moved._id },
            roomId: moved.roomId,
            takesRoomOutOfService: true,
            status: { $in: OPEN },
          }).session(session);
          const room = await Room.findOne({ _id: moved.roomId }).session(session).lean();
          if (!stillBlocked && room?.status === 'maintenance') {
            // If a cleaning is still waiting for this room, it goes back to cleaning so the
            // housekeeper finishing that task is what makes it available.
            const needsCleaning = await ServiceRequest.exists({
              roomId: room._id,
              type: 'room_cleaning',
              status: { $in: ['new', 'in_progress'] },
            }).session(session);
            const next = needsCleaning ? 'cleaning' : 'available';
            await rooms.changeStatus(room._id.toHexString(), next, { session });
            freed = { roomId: room._id, roomNumber: room.number, status: next };
          }
        }
        return { updated: moved.toObject(), released: freed };
      });
      await audit('resolved', updated, { roomReleased: Boolean(released) });
      await announce(updated, 'resolved');
      if (released) {
        announceRoomStatus(
          bus,
          updated.propertyId,
          released.roomId,
          released.roomNumber,
          released.status,
          'maintenance',
        );
      }
      return toDto(updated);
    },

    async escalate(actor, id, reason) {
      const updated = await MaintenanceIssue.findOneAndUpdate(
        { _id: id, status: { $in: OPEN } },
        { $set: { escalated: true, escalationReason: reason, escalatedAt: new Date() } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) {
        if (!(await MaintenanceIssue.exists({ _id: id }))) throw notFound('Issue not found');
        throw conflict('Only open issues can be escalated', 'bad_transition');
      }
      await audit('escalated', updated, { reason, by: actor.id.toHexString() });
      await announce(updated, 'escalated');
      return toDto(updated);
    },

    async acknowledge(actor, id) {
      const updated = await MaintenanceIssue.findOneAndUpdate(
        { _id: id, escalated: true },
        { $set: { escalated: false } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) {
        if (!(await MaintenanceIssue.exists({ _id: id }))) throw notFound('Issue not found');
        throw conflict('This issue is not escalated', 'not_escalated');
      }
      await audit('escalation_cleared', updated, { by: actor.id.toHexString() });
      await announce(updated, 'acknowledged');
      return toDto(updated);
    },
  };
}
