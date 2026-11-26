import { NIGHT_HOLDING_STATUSES, type BookingStatus } from '@hospitality/constants';
import type {
  AvailabilityDto,
  BookingDto,
  CalendarBookingDto,
  FrontDeskOverviewDto,
} from '@hospitality/shared-types';
import type { ClientSession, Types } from 'mongoose';
import { nightsOf, todayIn } from '../../shared/dates';
import { recordAudit } from '../../shared/audit/audit';
import type { HttpError } from '../../shared/errors';
import { badRequest, conflict, notFound } from '../../shared/errors';
import { eventBus, type EventBus } from '../../shared/events/event-bus';
import { getContext, getTenantId } from '../../shared/request-context';
import { transition } from '../../shared/state-machine';
import { inTransaction } from '../../shared/transaction';
import type { PropertyService } from '../properties/property.service';
import { Room, type RoomDocument } from '../rooms/room.model';
import { announceRoomStatus, type RoomService } from '../rooms/room.service';
import { RoomType, type RoomTypeDocument } from '../rooms/room-type.model';
import { Guest } from '../users/guest.model';
import { generateBookingCode } from './booking-code';
import { toBookingDto } from './booking.mapper';
import { Booking, type BookingDocument } from './booking.model';
import { bookingStatusMachine } from './booking-status';
import {
  busyRoomIds,
  calendar,
  findAvailability,
  frontDeskOverview,
  getBooking,
  listBookings,
  type AvailabilityInput,
  type ListBookingsInput,
} from './booking.queries';
import { RoomNight } from './room-night.model';

export interface CreateBookingInput {
  guestId?: string | undefined;
  guest?: { name: string; phone: string; email?: string | undefined } | undefined;
  roomTypeId: string;
  roomId?: string | undefined;
  checkInDate: string;
  checkOutDate: string;
  adults: number;
  children: number;
  notes: string;
  status: 'pending' | 'confirmed';
}

export interface UpdateBookingInput {
  checkInDate?: string | undefined;
  checkOutDate?: string | undefined;
  roomId?: string | undefined;
  adults?: number | undefined;
  children?: number | undefined;
  notes?: string | undefined;
}

export interface CheckInInput {
  roomId?: string | undefined;
  note?: string | undefined;
}

export interface BookingService {
  availability(input: AvailabilityInput): Promise<AvailabilityDto>;
  create(input: CreateBookingInput): Promise<BookingDto>;
  list(input: ListBookingsInput): Promise<{ items: BookingDto[]; total: number }>;
  get(id: string): Promise<BookingDto>;
  update(id: string, input: UpdateBookingInput): Promise<BookingDto>;
  confirm(id: string): Promise<BookingDto>;
  cancel(id: string, reason: string): Promise<BookingDto>;
  markNoShow(id: string): Promise<BookingDto>;
  checkIn(id: string, input: CheckInInput): Promise<BookingDto>;
  overview(): Promise<FrontDeskOverviewDto>;
  calendar(from: string, to: string): Promise<CalendarBookingDto[]>;
}

/** Thrown inside a transaction when another booking already holds one of the nights. */
class RoomTakenError extends Error {}

const roomUnavailable = (): HttpError =>
  conflict('That room is not free for all of those nights', 'room_unavailable');

/** A duplicate key on the nights index, as opposed to on the booking code. */
function isNightClash(error: unknown): boolean {
  const e = error as { code?: number; message?: string };
  return e?.code === 11000 && !String(e.message).includes('bookingCode');
}
function isCodeClash(error: unknown): boolean {
  const e = error as { code?: number; message?: string };
  return e?.code === 11000 && String(e.message).includes('bookingCode');
}

const NOT_READY = ['out_of_service', 'maintenance'];
const MAX_CODE_ATTEMPTS = 6;

export function createBookingService(
  properties: PropertyService,
  rooms: Pick<RoomService, 'changeStatus'>,
  bus: EventBus = eventBus,
): BookingService {
  const tenant = (): Types.ObjectId => {
    const id = getTenantId();
    if (!id) throw new Error('No tenant context');
    return id;
  };
  const timezone = async (): Promise<string> => (await properties.get(tenant())).timezone;
  const today = async (): Promise<string> => todayIn(await timezone());

  function announce(booking: BookingDocument, change: string): void {
    bus.emit({
      type: 'booking.changed',
      propertyId: booking.propertyId,
      audience: { departments: ['front_desk'] },
      data: {
        bookingId: booking._id.toHexString(),
        bookingCode: booking.bookingCode,
        status: booking.status,
        roomId: booking.roomId.toHexString(),
        change,
      },
    });
  }

  async function loadOrFail(id: string): Promise<BookingDocument> {
    const booking = await Booking.findOne({ _id: id }).lean();
    if (!booking) throw notFound('Booking not found');
    return booking;
  }

  async function usableType(id: string): Promise<RoomTypeDocument> {
    const type = await RoomType.findOne({ _id: id }).lean();
    if (!type?.active) throw badRequest('That room type is not available', 'unknown_room_type');
    return type;
  }

  function assertCapacity(type: RoomTypeDocument, adults: number, children: number): void {
    if (adults + children > type.capacity) {
      throw badRequest(`${type.name} rooms sleep at most ${type.capacity} guests`, 'over_capacity');
    }
  }

  async function assertRoomCanStart(room: RoomDocument, checkInDate: string, now: string) {
    if (checkInDate <= now && NOT_READY.includes(room.status)) {
      throw conflict(`Room ${room.number} is out of service`, 'room_out_of_service');
    }
  }

  /** Replaces all nights held by a booking. Runs inside a transaction. */
  async function writeNights(
    booking: { _id: Types.ObjectId; roomId: Types.ObjectId },
    checkInDate: string,
    checkOutDate: string,
    session: ClientSession,
  ): Promise<void> {
    await RoomNight.deleteMany({ bookingId: booking._id }, { session });
    await RoomNight.insertMany(
      nightsOf(checkInDate, checkOutDate).map((night) => ({
        roomId: booking.roomId,
        night,
        bookingId: booking._id,
      })),
      { session, ordered: true },
    );
  }

  async function resolveGuest(input: CreateBookingInput) {
    if (input.guestId) {
      const guest = await Guest.findOne({ _id: input.guestId }).lean();
      if (!guest) throw badRequest('That guest does not exist', 'unknown_guest');
      return guest;
    }
    const details = input.guest;
    if (!details) throw badRequest('Guest details are required', 'unknown_guest');
    const existing = await Guest.findOne({ phone: details.phone }).lean();
    if (existing) return existing;
    try {
      const created = await Guest.create({
        name: details.name,
        phone: details.phone,
        ...(details.email ? { email: details.email } : {}),
      });
      return created.toObject();
    } catch (error) {
      // Another request created the same guest a moment ago.
      const winner = await Guest.findOne({ phone: details.phone }).lean();
      if (winner) return winner;
      throw error;
    }
  }

  async function createInRoom(
    input: CreateBookingInput,
    type: RoomTypeDocument,
    guest: { _id: Types.ObjectId; name: string; phone: string; email: string | null },
    roomId: Types.ObjectId,
  ): Promise<BookingDocument> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      try {
        return await inTransaction(async (session) => {
          const [booking] = await Booking.create(
            [
              {
                bookingCode: generateBookingCode(),
                guestId: guest._id,
                guestSnapshot: { name: guest.name, phone: guest.phone, email: guest.email },
                roomTypeId: type._id,
                roomId,
                checkInDate: input.checkInDate,
                checkOutDate: input.checkOutDate,
                nights: nightsOf(input.checkInDate, input.checkOutDate).length,
                adults: input.adults,
                children: input.children,
                nightlyRatePaise: type.ratePaise,
                notes: input.notes,
                status: input.status,
                history: [
                  {
                    from: null,
                    to: input.status,
                    at: new Date(),
                    ...(getContext()?.principal ? { by: getContext()?.principal } : {}),
                  },
                ],
              },
            ],
            { session },
          );
          if (!booking) throw new Error('Booking was not created');
          await writeNights(booking, input.checkInDate, input.checkOutDate, session);
          return booking.toObject();
        });
      } catch (error) {
        if (isCodeClash(error)) continue;
        if (isNightClash(error)) throw new RoomTakenError();
        throw error;
      }
    }
    throw new Error('Could not generate a unique booking code');
  }

  return {
    async availability(input) {
      return findAvailability(input, await today());
    },

    async create(input) {
      const now = await today();
      if (input.checkInDate < now) {
        throw badRequest('The check-in date is in the past', 'date_in_past');
      }
      const type = await usableType(input.roomTypeId);
      assertCapacity(type, input.adults, input.children);

      let candidates: RoomDocument[];
      if (input.roomId) {
        const room = await Room.findOne({ _id: input.roomId }).lean();
        if (!room?.active || !room.roomTypeId.equals(type._id)) {
          throw badRequest('That room is not a room of the chosen type', 'unknown_room');
        }
        await assertRoomCanStart(room, input.checkInDate, now);
        candidates = [room];
      } else {
        const all = await Room.find({ roomTypeId: type._id, active: true })
          .sort({ number: 1 })
          .collation({ locale: 'en', numericOrdering: true })
          .lean();
        const busy = await busyRoomIds(
          all.map((room) => room._id),
          nightsOf(input.checkInDate, input.checkOutDate),
        );
        candidates = all
          .filter((room) => !busy.has(room._id.toHexString()))
          .filter((room) => !(input.checkInDate <= now && NOT_READY.includes(room.status)));
      }
      if (candidates.length === 0) {
        throw conflict('No room of that type is free for those dates', 'no_room_available');
      }

      const guest = await resolveGuest(input);
      for (const room of candidates) {
        try {
          const booking = await createInRoom(input, type, guest, room._id);
          await recordAudit({
            action: 'booking.created',
            target: { type: 'booking', id: booking._id.toHexString() },
            summary: {
              bookingCode: booking.bookingCode,
              roomId: room._id.toHexString(),
              checkInDate: input.checkInDate,
              checkOutDate: input.checkOutDate,
            },
          });
          announce(booking, 'created');
          return await toBookingDto(booking);
        } catch (error) {
          // Someone else took this room between our check and our insert: try the next one.
          if (error instanceof RoomTakenError) continue;
          throw error;
        }
      }
      throw input.roomId
        ? roomUnavailable()
        : conflict('No room of that type is free for those dates', 'no_room_available');
    },

    list: (input) => listBookings(input),
    get: (id) => getBooking(id),

    async update(id, input) {
      const booking = await loadOrFail(id);
      const now = await today();
      const holding = (NIGHT_HOLDING_STATUSES as readonly string[]).includes(booking.status);
      if (!holding) {
        throw conflict(
          `A ${booking.status.replace('_', '-')} booking cannot be changed`,
          'booking_closed',
        );
      }
      const inHouse = booking.status === 'checked_in';

      const checkInDate = input.checkInDate ?? booking.checkInDate;
      const checkOutDate = input.checkOutDate ?? booking.checkOutDate;
      const nights = nightsOf(checkInDate, checkOutDate).length;
      if (nights < 1) throw badRequest('The check-out must be after the check-in', 'bad_dates');
      if (nights > 90) throw badRequest('A stay can be at most 90 nights', 'bad_dates');

      if (inHouse) {
        if (checkInDate !== booking.checkInDate || input.roomId) {
          throw conflict(
            'A guest who has checked in can only have the stay extended or shortened',
            'booking_in_house',
          );
        }
        if (checkOutDate <= now) {
          throw badRequest('The new check-out date must be after today', 'date_in_past');
        }
      } else if (checkInDate < now && checkInDate !== booking.checkInDate) {
        throw badRequest('The check-in date is in the past', 'date_in_past');
      }

      const roomId = input.roomId ? input.roomId : booking.roomId.toHexString();
      const roomChanged = roomId !== booking.roomId.toHexString();
      const datesChanged =
        checkInDate !== booking.checkInDate || checkOutDate !== booking.checkOutDate;

      let type: RoomTypeDocument | null = await RoomType.findOne({
        _id: booking.roomTypeId,
      }).lean();
      let room: RoomDocument | null = null;
      if (roomChanged) {
        room = await Room.findOne({ _id: roomId }).lean();
        if (!room?.active) throw badRequest('That room does not exist', 'unknown_room');
        type = await usableType(room.roomTypeId.toHexString());
        await assertRoomCanStart(room, checkInDate, now);
      }
      if (!type) throw badRequest('The room type no longer exists', 'unknown_room_type');
      const adults = input.adults ?? booking.adults;
      const children = input.children ?? booking.children;
      assertCapacity(type, adults, children);

      const set: Record<string, unknown> = {
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        adults,
        children,
        checkInDate,
        checkOutDate,
        nights,
      };
      if (roomChanged && room) {
        set.roomId = room._id;
        if (!room.roomTypeId.equals(booking.roomTypeId)) {
          // A different type is priced at its own current tariff.
          set.roomTypeId = type._id;
          set.nightlyRatePaise = type.ratePaise;
        }
      }

      try {
        const updated = await inTransaction(async (session) => {
          // The status is part of the filter, so a check-in or cancellation that happened while
          // we were deciding wins and this change is refused.
          const result = await Booking.findOneAndUpdate(
            { _id: id, status: booking.status },
            { $set: set },
            { returnDocument: 'after', session, runValidators: true },
          ).lean();
          if (!result) {
            throw conflict(
              'The booking changed while you were editing it, please reload',
              'conflict',
            );
          }
          if (datesChanged || roomChanged) {
            await writeNights(result, checkInDate, checkOutDate, session);
          }
          return result;
        });
        await recordAudit({
          action: 'booking.updated',
          target: { type: 'booking', id },
          summary: {
            bookingCode: booking.bookingCode,
            before: {
              checkInDate: booking.checkInDate,
              checkOutDate: booking.checkOutDate,
              roomId: booking.roomId.toHexString(),
            },
            after: { checkInDate, checkOutDate, roomId },
          },
        });
        announce(updated, 'changed');
        return await toBookingDto(updated);
      } catch (error) {
        if (isNightClash(error)) throw roomUnavailable();
        throw error;
      }
    },

    async confirm(id) {
      return moveBooking(id, 'confirmed', 'confirmed', {});
    },

    async cancel(id, reason) {
      return moveBooking(
        id,
        'cancelled',
        'cancelled',
        { cancelledAt: new Date(), cancelReason: reason },
        {
          releaseNights: true,
          note: reason,
        },
      );
    },

    async markNoShow(id) {
      const booking = await loadOrFail(id);
      if (booking.checkInDate > (await today())) {
        throw conflict('A booking cannot be a no-show before its arrival date', 'too_early');
      }
      return moveBooking(id, 'no_show', 'no_show', {}, { releaseNights: true });
    },

    async checkIn(id, input) {
      const booking = await loadOrFail(id);
      const now = await today();
      if (booking.status !== 'confirmed') {
        throw conflict(
          booking.status === 'pending'
            ? 'Confirm the booking before checking in'
            : `A ${booking.status.replace('_', '-')} booking cannot be checked in`,
          'bad_transition',
        );
      }
      if (booking.checkInDate > now) {
        throw conflict(`This booking arrives on ${booking.checkInDate}`, 'not_arrival_day');
      }
      if (booking.checkOutDate <= now) {
        throw conflict('This stay has already ended', 'stay_ended');
      }

      const targetId = input.roomId ?? booking.roomId.toHexString();
      const room = await Room.findOne({ _id: targetId }).lean();
      if (!room?.active) throw badRequest('That room does not exist', 'unknown_room');
      if (!['available', 'reserved'].includes(room.status)) {
        throw conflict(
          `Room ${room.number} is not ready (it is ${room.status.replace('_', ' ')})`,
          'room_not_ready',
        );
      }
      const roomChanged = targetId !== booking.roomId.toHexString();
      const type = await usableType(room.roomTypeId.toHexString());
      assertCapacity(type, booking.adults, booking.children);

      try {
        const updated = await inTransaction(async (session) => {
          if (roomChanged) {
            // Move the held nights to the new room first; the unique index refuses a clash.
            const moved = await Booking.findOneAndUpdate(
              { _id: id, status: 'confirmed' },
              {
                $set: {
                  roomId: room._id,
                  ...(room.roomTypeId.equals(booking.roomTypeId)
                    ? {}
                    : { roomTypeId: type._id, nightlyRatePaise: type.ratePaise }),
                },
              },
              { returnDocument: 'after', session },
            ).lean();
            if (!moved) throw conflict('The booking changed, please reload', 'conflict');
            // The dates may have been changed by someone else since we read the booking.
            // The nights must follow the booking as it is now, so refuse if they moved.
            if (
              moved.checkInDate !== booking.checkInDate ||
              moved.checkOutDate !== booking.checkOutDate
            ) {
              throw conflict('The booking changed, please reload', 'conflict');
            }
            await writeNights(moved, moved.checkInDate, moved.checkOutDate, session);
          }
          const checkedIn = await transition({
            model: Booking,
            id,
            machine: bookingStatusMachine,
            to: 'checked_in',
            set: { checkedInAt: new Date() },
            ...(input.note ? { note: input.note } : {}),
            session,
          });
          await rooms.changeStatus(room._id.toHexString(), 'occupied', { session });
          return checkedIn.toObject();
        });
        await recordAudit({
          action: 'booking.checked_in',
          target: { type: 'booking', id },
          summary: { bookingCode: booking.bookingCode, roomId: targetId, roomChanged },
        });
        announce(updated, 'checked_in');
        announceRoomStatus(bus, updated.propertyId, room._id, room.number, 'occupied', room.status);
        return await toBookingDto(updated);
      } catch (error) {
        if (isNightClash(error)) throw roomUnavailable();
        throw error;
      }
    },

    overview: async () => frontDeskOverview(await timezone()),
    calendar: (from, to) => calendar(from, to),
  };

  /** Moves a booking to a new status, optionally freeing its nights in the same transaction. */
  async function moveBooking(
    id: string,
    to: BookingStatus,
    change: string,
    set: Record<string, unknown>,
    options: { releaseNights?: boolean; note?: string } = {},
  ): Promise<BookingDto> {
    const updated = await inTransaction(async (session) => {
      const moved = await transition({
        model: Booking,
        id,
        machine: bookingStatusMachine,
        to,
        ...(Object.keys(set).length ? { set } : {}),
        ...(options.note ? { note: options.note } : {}),
        session,
      });
      if (options.releaseNights) await RoomNight.deleteMany({ bookingId: moved._id }, { session });
      return moved.toObject();
    });
    await recordAudit({
      action: `booking.${change}`,
      target: { type: 'booking', id },
      summary: {
        bookingCode: updated.bookingCode,
        ...(options.note ? { reason: options.note } : {}),
      },
    });
    announce(updated, change);
    return toBookingDto(updated);
  }
}
