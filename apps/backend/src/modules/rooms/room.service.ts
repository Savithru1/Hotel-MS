import type { RoomStatus } from '@hospitality/constants';
import type { RoomDto, RoomTypeDto } from '@hospitality/shared-types';
import type { ClientSession, Types } from 'mongoose';
import { recordAudit } from '../../shared/audit/audit';
import { eventBus, type EventBus } from '../../shared/events/event-bus';
import { badRequest, conflict, notFound } from '../../shared/errors';
import { transition } from '../../shared/state-machine';
import { Booking } from '../bookings/booking.model';
import { MaintenanceIssue } from '../maintenance/maintenance.model';
import { Room, type RoomDocument } from './room.model';
import { roomStatusMachine } from './room-status';
import { RoomType, type RoomTypeDocument } from './room-type.model';

export interface CreateRoomTypeInput {
  name: string;
  capacity: number;
  ratePaise: number;
  amenities: string[];
}

export interface UpdateRoomTypeInput {
  name?: string | undefined;
  capacity?: number | undefined;
  ratePaise?: number | undefined;
  amenities?: string[] | undefined;
  active?: boolean | undefined;
}

export interface CreateRoomInput {
  number: string;
  floor: number;
  roomTypeId: string;
}

export interface UpdateRoomInput {
  number?: string | undefined;
  floor?: number | undefined;
  roomTypeId?: string | undefined;
  active?: boolean | undefined;
}

export interface ListRoomsInput {
  page: number;
  limit: number;
  floor?: number | undefined;
  roomTypeId?: string | undefined;
  status?: string | undefined;
  active?: boolean | undefined;
}

export interface ChangeStatusOptions {
  note?: string | undefined;
  /** Pass the session of a surrounding transaction so the move commits or rolls back with it. */
  session?: ClientSession | undefined;
}

export interface RoomService {
  listTypes(): Promise<RoomTypeDto[]>;
  createType(input: CreateRoomTypeInput): Promise<RoomTypeDto>;
  updateType(id: string, input: UpdateRoomTypeInput): Promise<RoomTypeDto>;

  list(input: ListRoomsInput): Promise<{ items: RoomDto[]; total: number }>;
  get(id: string): Promise<RoomDto>;
  create(input: CreateRoomInput): Promise<RoomDto>;
  update(id: string, input: UpdateRoomInput): Promise<RoomDto>;
  /**
   * Moves a room along the status workflow. Used by staff (limited to a few statuses by the
   * route) and by bookings, housekeeping and maintenance, which may use any legal move.
   */
  changeStatus(id: string, to: RoomStatus, options?: ChangeStatusOptions): Promise<RoomDto>;
  /**
   * A change made by hand by staff. On top of the workflow table it refuses a room with a
   * guest in it and a room that an open maintenance issue is holding out of service, because
   * those are only released by check-out and by resolving the issue.
   */
  changeStatusByHand(id: string, to: RoomStatus, note?: string): Promise<RoomDto>;
}

export const toRoomTypeDto = (type: RoomTypeDocument): RoomTypeDto => ({
  id: type._id.toHexString(),
  name: type.name,
  capacity: type.capacity,
  ratePaise: type.ratePaise,
  amenities: [...type.amenities],
  active: type.active,
});

const toRoomDto = (room: RoomDocument, typeName: string | null): RoomDto => ({
  id: room._id.toHexString(),
  number: room.number,
  floor: room.floor,
  roomTypeId: room.roomTypeId.toHexString(),
  roomTypeName: typeName,
  status: room.status,
  active: room.active,
});

/** Statuses in which a guest is in, or due in, the room. Such a room cannot be retired. */
const BUSY: RoomStatus[] = ['occupied', 'reserved'];

export function createRoomService(bus: EventBus = eventBus): RoomService {
  async function typeNames(ids: Types.ObjectId[]): Promise<Map<string, string>> {
    const types = await RoomType.find({ _id: { $in: ids } }, { name: 1 }).lean();
    return new Map(types.map((type) => [type._id.toHexString(), type.name]));
  }

  async function toDto(room: RoomDocument): Promise<RoomDto> {
    const names = await typeNames([room.roomTypeId]);
    return toRoomDto(room, names.get(room.roomTypeId.toHexString()) ?? null);
  }

  async function requireUsableType(id: string): Promise<void> {
    const type = await RoomType.findOne({ _id: id }, { active: 1 }).lean();
    if (!type) throw badRequest('That room type does not exist', 'unknown_room_type');
    if (!type.active) throw badRequest('That room type is switched off', 'room_type_inactive');
  }

  const isDuplicate = (error: unknown): boolean => (error as { code?: unknown })?.code === 11000;

  const service: RoomService = {
    async listTypes() {
      const types = await RoomType.find()
        .sort({ name: 1 })
        .collation({ locale: 'en', strength: 2 })
        .lean();
      return types.map(toRoomTypeDto);
    },

    async createType(input) {
      try {
        const created = await RoomType.create(input);
        await recordAudit({
          action: 'room_type.created',
          target: { type: 'room_type', id: created._id.toHexString() },
          summary: { name: input.name, ratePaise: input.ratePaise },
        });
        return toRoomTypeDto(created.toObject());
      } catch (error) {
        if (isDuplicate(error))
          throw conflict('A room type with that name already exists', 'room_type_name_taken');
        throw error;
      }
    },

    async updateType(id, input) {
      const before = await RoomType.findOne({ _id: id }).lean();
      if (!before) throw notFound('Room type not found');

      if (input.active === false && before.active) {
        const inUse = await Room.exists({ roomTypeId: before._id, active: true });
        if (inUse) {
          throw conflict('Move or retire the rooms of this type first', 'room_type_in_use');
        }
      }

      const set = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      let updated;
      try {
        updated = await RoomType.findOneAndUpdate(
          { _id: id },
          { $set: set },
          { returnDocument: 'after', runValidators: true },
        ).lean();
      } catch (error) {
        if (isDuplicate(error))
          throw conflict('A room type with that name already exists', 'room_type_name_taken');
        throw error;
      }
      if (!updated) throw notFound('Room type not found');

      await recordAudit({
        action: 'room_type.updated',
        target: { type: 'room_type', id },
        summary: {
          before: { name: before.name, ratePaise: before.ratePaise, active: before.active },
          after: { name: updated.name, ratePaise: updated.ratePaise, active: updated.active },
        },
      });
      return toRoomTypeDto(updated);
    },

    async list({ page, limit, floor, roomTypeId, status, active }) {
      const filter = {
        ...(floor === undefined ? {} : { floor }),
        ...(roomTypeId ? { roomTypeId } : {}),
        ...(status ? { status: status as RoomStatus } : {}),
        ...(active === undefined ? {} : { active }),
      };
      const [rooms, total] = await Promise.all([
        Room.find(filter)
          .sort({ floor: 1, number: 1 })
          .collation({ locale: 'en', numericOrdering: true })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        Room.countDocuments(filter),
      ]);
      const names = await typeNames([...new Set(rooms.map((room) => room.roomTypeId))]);
      return {
        items: rooms.map((room) =>
          toRoomDto(room, names.get(room.roomTypeId.toHexString()) ?? null),
        ),
        total,
      };
    },

    async get(id) {
      const room = await Room.findOne({ _id: id }).lean();
      if (!room) throw notFound('Room not found');
      return toDto(room);
    },

    async create(input) {
      await requireUsableType(input.roomTypeId);
      try {
        const created = await Room.create(input);
        await recordAudit({
          action: 'room.created',
          target: { type: 'room', id: created._id.toHexString() },
          summary: { number: input.number, floor: input.floor },
        });
        return toDto(created.toObject());
      } catch (error) {
        if (isDuplicate(error))
          throw conflict('A room with that number already exists', 'room_number_taken');
        throw error;
      }
    },

    async update(id, input) {
      const before = await Room.findOne({ _id: id }).lean();
      if (!before) throw notFound('Room not found');

      if (input.roomTypeId && input.roomTypeId !== before.roomTypeId.toHexString()) {
        await requireUsableType(input.roomTypeId);
      }
      if (
        input.active === false &&
        (BUSY.includes(before.status) ||
          (await Booking.exists({
            roomId: before._id,
            status: { $in: ['pending', 'confirmed', 'checked_in'] },
          })))
      ) {
        throw conflict('A room with a guest in it or due in cannot be retired', 'room_in_use');
      }

      const set = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      let updated;
      try {
        // The status is part of the filter so a booking that moved the room meanwhile wins.
        updated = await Room.findOneAndUpdate(
          { _id: id, status: before.status },
          { $set: set },
          { returnDocument: 'after', runValidators: true },
        ).lean();
      } catch (error) {
        if (isDuplicate(error))
          throw conflict('A room with that number already exists', 'room_number_taken');
        throw error;
      }
      if (!updated)
        throw conflict('The room changed while you were editing it, please reload', 'conflict');

      await recordAudit({
        action: 'room.updated',
        target: { type: 'room', id },
        summary: { fields: Object.keys(set) },
      });
      return toDto(updated);
    },

    async changeStatusByHand(id, to, note) {
      const room = await Room.findOne({ _id: id }).lean();
      if (!room) throw notFound('Room not found');
      if (
        room.status === 'occupied' ||
        (await Booking.exists({ roomId: room._id, status: 'checked_in' }))
      ) {
        throw conflict(
          `Room ${room.number} has a guest in it. Check-out changes it, not a manual edit.`,
          'room_occupied',
        );
      }
      if (
        room.status === 'maintenance' &&
        (await MaintenanceIssue.exists({
          roomId: room._id,
          takesRoomOutOfService: true,
          status: { $in: ['new', 'assigned', 'in_progress'] },
        }))
      ) {
        throw conflict(
          `Room ${room.number} is held out of service by an open maintenance issue. Resolve the issue to release it.`,
          'held_by_maintenance',
        );
      }
      return service.changeStatus(id, to, note ? { note } : {});
    },

    async changeStatus(id, to, options = {}) {
      const updated = await transition({
        model: Room,
        id,
        machine: roomStatusMachine,
        to,
        ...(options.note ? { note: options.note } : {}),
        ...(options.session ? { session: options.session } : {}),
      });
      const previous = updated.history.at(-1)?.from ?? to;
      // Announce after the change is saved. With a surrounding transaction the caller emits once
      // it has committed, so it passes `session` and calls `announceRoomStatus` itself.
      if (!options.session) {
        announceRoomStatus(bus, updated.propertyId, updated._id, updated.number, to, previous);
      }
      return toDto(updated.toObject());
    },
  };
  return service;
}

/** Tells the front desk, housekeeping and managers that a room changed status. */
export function announceRoomStatus(
  bus: EventBus,
  propertyId: Types.ObjectId,
  roomId: Types.ObjectId,
  roomNumber: string,
  status: string,
  previous: string,
): void {
  bus.emit({
    type: 'room.status_changed',
    propertyId,
    audience: { departments: ['front_desk', 'housekeeping'] },
    data: { roomId: roomId.toHexString(), roomNumber, status, previous },
  });
}
