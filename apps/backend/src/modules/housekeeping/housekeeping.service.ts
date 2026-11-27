import {
  isManagementRole,
  type HousekeepingStatus,
  type ServiceRequestType,
} from '@hospitality/constants';
import type { HousekeepingRequestDto, QueueSummaryDto } from '@hospitality/shared-types';
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
import {
  ServiceRequest,
  housekeepingMachine,
  type ServiceRequestDocument,
} from '../service-requests/service-request.model';
import { assertAssignable, assigneeMap } from '../staff/staff-lookup';

export interface CreateHousekeepingInput {
  roomId: string;
  type: ServiceRequestType;
  notes: string;
  priority: 'normal' | 'urgent';
}

export interface ListHousekeepingInput {
  page: number;
  limit: number;
  status?: string | undefined;
  roomId?: string | undefined;
  mine?: boolean | undefined;
  escalated?: boolean | undefined;
  open?: boolean | undefined;
}

export interface HousekeepingService {
  create(
    actor: AuthenticatedStaff,
    input: CreateHousekeepingInput,
  ): Promise<HousekeepingRequestDto>;
  list(
    actor: AuthenticatedStaff,
    input: ListHousekeepingInput,
  ): Promise<{ items: HousekeepingRequestDto[]; total: number }>;
  get(id: string): Promise<HousekeepingRequestDto>;
  summary(): Promise<QueueSummaryDto>;
  assign(actor: AuthenticatedStaff, id: string, staffId: string): Promise<HousekeepingRequestDto>;
  start(actor: AuthenticatedStaff, id: string): Promise<HousekeepingRequestDto>;
  complete(actor: AuthenticatedStaff, id: string, note?: string): Promise<HousekeepingRequestDto>;
  cancel(actor: AuthenticatedStaff, id: string, reason: string): Promise<HousekeepingRequestDto>;
  escalate(actor: AuthenticatedStaff, id: string, reason: string): Promise<HousekeepingRequestDto>;
  acknowledge(actor: AuthenticatedStaff, id: string): Promise<HousekeepingRequestDto>;
}

const OPEN: HousekeepingStatus[] = ['new', 'in_progress'];

const isManager = (actor: AuthenticatedStaff): boolean =>
  isManagementRole(actor.role) || actor.role === 'platform_admin';

/** A history line for a hand-over: the status does not change, only the person. */
function handOverEntry(status: HousekeepingStatus, name: string): HistoryEntry {
  const by = getContext()?.principal;
  return {
    from: status,
    to: status,
    at: new Date(),
    ...(by ? { by } : {}),
    note: `Reassigned to ${name}`,
  };
}

async function toDtos(requests: ServiceRequestDocument[]): Promise<HousekeepingRequestDto[]> {
  if (requests.length === 0) return [];
  const [rooms, people] = await Promise.all([
    Room.find({ _id: { $in: [...new Set(requests.map((r) => r.roomId))] } }, { number: 1 }).lean(),
    assigneeMap(requests.map((r) => r.assignedTo)),
  ]);
  const numbers = new Map(rooms.map((room) => [room._id.toHexString(), room.number]));
  return requests.map((request) => ({
    id: request._id.toHexString(),
    type: request.type,
    roomId: request.roomId.toHexString(),
    roomNumber: numbers.get(request.roomId.toHexString()) ?? null,
    bookingId: request.bookingId ? request.bookingId.toHexString() : null,
    guestName: request.guestName,
    notes: request.notes,
    priority: request.priority,
    status: request.status,
    assignedTo: request.assignedTo ? (people.get(request.assignedTo.toHexString()) ?? null) : null,
    escalated: request.escalated,
    escalationReason: request.escalationReason,
    source: request.source,
    createdAt: request.createdAt.toISOString(),
    completedAt: request.completedAt ? request.completedAt.toISOString() : null,
  }));
}

async function toDto(request: ServiceRequestDocument): Promise<HousekeepingRequestDto> {
  const [dto] = await toDtos([request]);
  if (!dto) throw new Error('Could not build the request');
  return dto;
}

export function createHousekeepingService(
  rooms: Pick<RoomService, 'changeStatus'>,
  bus: EventBus = eventBus,
): HousekeepingService {
  async function roomNumber(roomId: Types.ObjectId): Promise<string> {
    const room = await Room.findOne({ _id: roomId }, { number: 1 }).lean();
    return room?.number ?? '?';
  }

  async function announce(request: ServiceRequestDocument, change: string): Promise<void> {
    bus.emit({
      type: 'housekeeping.changed',
      propertyId: request.propertyId,
      audience: { departments: ['housekeeping', 'front_desk'] },
      data: {
        requestId: request._id.toHexString(),
        roomId: request.roomId.toHexString(),
        roomNumber: await roomNumber(request.roomId),
        status: request.status,
        change,
        escalated: request.escalated,
        assignedTo: request.assignedTo ? request.assignedTo.toHexString() : null,
      },
    });
  }

  async function load(id: string): Promise<ServiceRequestDocument> {
    const request = await ServiceRequest.findOne({ _id: id }).lean();
    if (!request) throw notFound('Request not found');
    return request;
  }

  /** The person doing the work, or a manager. Anyone else cannot move someone else's task. */
  function assertMayWork(actor: AuthenticatedStaff, request: ServiceRequestDocument): void {
    if (isManagementRole(actor.role) || actor.role === 'platform_admin') return;
    if (request.assignedTo && !request.assignedTo.equals(actor.id)) {
      throw forbidden('This task is assigned to someone else', 'assigned_to_someone_else');
    }
  }

  async function audit(action: string, request: ServiceRequestDocument, extra = {}): Promise<void> {
    await recordAudit({
      action: `housekeeping.${action}`,
      target: { type: 'service_request', id: request._id.toHexString() },
      summary: { type: request.type, roomId: request.roomId.toHexString(), ...extra },
    });
  }

  return {
    async create(actor, input) {
      const room = await Room.findOne({ _id: input.roomId, active: true }).lean();
      if (!room) throw badRequest('That room does not exist', 'unknown_room');

      // Requests for a guest need a guest in the room. Cleaning an empty room does not.
      const booking = await Booking.findOne({ roomId: room._id, status: 'checked_in' }).lean();
      if (!booking && input.type !== 'room_cleaning') {
        throw conflict(`Room ${room.number} has no guest checked in`, 'no_guest_in_room');
      }

      const created = await ServiceRequest.create({
        type: input.type,
        roomId: room._id,
        bookingId: booking?._id ?? null,
        guestName: booking?.guestSnapshot.name ?? null,
        notes: input.notes,
        priority: input.priority,
        priorityRank: input.priority === 'urgent' ? 1 : 0,
        source: actor.role === 'housekeeping' ? 'housekeeping' : 'front_desk',
        createdBy: actor.id.toHexString(),
        history: [
          {
            from: null,
            to: 'new',
            at: new Date(),
            by: { kind: 'staff', id: actor.id.toHexString(), role: actor.role },
          },
        ],
      });
      const request = created.toObject();
      await audit('created', request);
      await announce(request, 'created');
      return toDto(request);
    },

    async list(actor, input) {
      const filter: Record<string, unknown> = {};
      if (input.status) filter.status = input.status;
      if (input.roomId) filter.roomId = input.roomId;
      if (input.escalated !== undefined) filter.escalated = input.escalated;
      if (input.mine) filter.assignedTo = actor.id;
      if (input.open) filter.status = { $in: OPEN };

      const [items, total] = await Promise.all([
        ServiceRequest.find(filter)
          .sort({ priorityRank: -1, createdAt: 1, _id: 1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        ServiceRequest.countDocuments(filter),
      ]);
      return { items: await toDtos(items), total };
    },

    async get(id) {
      return toDto(await load(id));
    },

    async summary() {
      const [rows, escalated, urgent] = await Promise.all([
        ServiceRequest.aggregate<{ _id: string; count: number }>([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        ServiceRequest.countDocuments({ status: { $in: OPEN }, escalated: true }),
        ServiceRequest.countDocuments({ status: { $in: OPEN }, priority: 'urgent' }),
      ]);
      const byStatus: Record<string, number> = {
        new: 0,
        in_progress: 0,
        completed: 0,
        cancelled: 0,
      };
      for (const row of rows) byStatus[row._id] = row.count;
      return { byStatus, escalated, urgent };
    },

    async assign(actor, id, staffId) {
      const person = await assertAssignable(staffId, 'housekeeping');
      const request = await load(id);
      const reassigning = request.status === 'in_progress';
      if (request.status !== 'new' && !(reassigning && isManager(actor))) {
        throw conflict(
          'Only a task that has not started can be handed to someone',
          'bad_transition',
        );
      }
      if (reassigning && request.assignedTo?.equals(person.id)) {
        throw conflict('The task is already assigned to that person', 'bad_transition');
      }
      // Both the status and the previous assignee are in the filter, so two managers assigning at
      // once cannot both succeed: the second one's filter no longer matches and it gets a 409.
      const updated = await ServiceRequest.findOneAndUpdate(
        { _id: id, status: request.status, assignedTo: request.assignedTo },
        {
          $set: { assignedTo: person.id },
          ...(reassigning
            ? { $push: { history: handOverEntry(request.status, person.name) } }
            : {}),
        },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) throw conflict('The task changed while you were assigning it', 'conflict');
      const action = reassigning ? 'reassigned' : 'assigned';
      await audit(action, updated, {
        assignedTo: staffId,
        by: actor.id.toHexString(),
        ...(reassigning ? { previous: request.assignedTo?.toHexString() ?? null } : {}),
      });
      await announce(updated, action);
      return toDto(updated);
    },

    async start(actor, id) {
      const request = await load(id);
      assertMayWork(actor, request);
      const moved = await transition({
        model: ServiceRequest,
        id,
        machine: housekeepingMachine,
        to: 'in_progress',
        set: { assignedTo: request.assignedTo ?? actor.id },
      });
      const updated = moved.toObject();
      await audit('started', updated);
      await announce(updated, 'started');
      return toDto(updated);
    },

    async complete(actor, id, note) {
      const request = await load(id);
      assertMayWork(actor, request);

      const { updated, released } = await inTransaction(async (session) => {
        const moved = await transition({
          model: ServiceRequest,
          id,
          machine: housekeepingMachine,
          to: 'completed',
          set: { completedAt: new Date(), escalated: false },
          ...(note ? { note } : {}),
          session,
        });
        // The room-state chain: finishing a cleaning frees a room that was waiting to be cleaned.
        let freed: { roomId: Types.ObjectId; roomNumber: string } | null = null;
        if (moved.type === 'room_cleaning') {
          const room = await Room.findOne({ _id: moved.roomId }).session(session).lean();
          if (room?.status === 'cleaning') {
            await rooms.changeStatus(room._id.toHexString(), 'available', { session });
            freed = { roomId: room._id, roomNumber: room.number };
          }
        }
        return { updated: moved.toObject(), released: freed };
      });
      await audit('completed', updated, released ? { roomReleased: true } : {});
      await announce(updated, 'completed');
      if (released) {
        announceRoomStatus(
          bus,
          updated.propertyId,
          released.roomId,
          released.roomNumber,
          'available',
          'cleaning',
        );
      }
      return toDto(updated);
    },

    async cancel(actor, id, reason) {
      const moved = await transition({
        model: ServiceRequest,
        id,
        machine: housekeepingMachine,
        to: 'cancelled',
        set: { escalated: false },
        note: reason,
      });
      const updated = moved.toObject();
      await audit('cancelled', updated, { reason, by: actor.id.toHexString() });
      await announce(updated, 'cancelled');
      return toDto(updated);
    },

    async escalate(actor, id, reason) {
      const updated = await ServiceRequest.findOneAndUpdate(
        { _id: id, status: { $in: OPEN } },
        { $set: { escalated: true, escalationReason: reason, escalatedAt: new Date() } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) {
        const exists = await ServiceRequest.exists({ _id: id });
        if (!exists) throw notFound('Request not found');
        throw conflict('Only open requests can be escalated', 'bad_transition');
      }
      await audit('escalated', updated, { reason, by: actor.id.toHexString() });
      await announce(updated, 'escalated');
      return toDto(updated);
    },

    async acknowledge(actor, id) {
      const updated = await ServiceRequest.findOneAndUpdate(
        { _id: id, escalated: true },
        { $set: { escalated: false } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) {
        if (!(await ServiceRequest.exists({ _id: id }))) throw notFound('Request not found');
        throw conflict('This request is not escalated', 'not_escalated');
      }
      await audit('escalation_cleared', updated, { by: actor.id.toHexString() });
      await announce(updated, 'acknowledged');
      return toDto(updated);
    },
  };
}
