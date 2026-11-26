import {
  FACILITY_BOOKING_STATUSES,
  FACILITY_HOLDING_STATUSES,
  type FacilityBookingStatus,
} from '@hospitality/constants';
import type { FacilityBookingDto, FacilityBookingSummaryDto } from '@hospitality/shared-types';
import type { ClientSession, Types } from 'mongoose';
import { recordAudit } from '../../shared/audit/audit';
import { localDateTimeToUtc } from '../../shared/dates';
import { badRequest, conflict, notFound } from '../../shared/errors';
import { eventBus, type EventBus } from '../../shared/events/event-bus';
import { generateReadableCode } from '../../shared/readable-code';
import { getContext, getTenantId } from '../../shared/request-context';
import { canTransition, transition } from '../../shared/state-machine';
import { inTransaction } from '../../shared/transaction';
import type { AuthenticatedStaff } from '../auth/auth.types';
import { Booking } from '../bookings/booking.model';
import type { PropertyService } from '../properties/property.service';
import { Bill } from '../billing/bill.model';
import { Room } from '../rooms/room.model';
import {
  FacilityBooking,
  facilityBookingMachine,
  type FacilityBookingDocument,
} from './facility-booking.model';
import { FacilitySlot } from './facility-slot.model';
import { findSlot } from './facility-slots';
import { Facility } from './facility.model';
import { toFacilityBookingDto } from './facility.mapper';

export interface CreateFacilityBookingInput {
  facilityId: string;
  roomId: string;
  date: string;
  startTime: string;
  participants: number;
  notes: string;
}

export interface ListFacilityBookingsInput {
  page: number;
  limit: number;
  date?: string | undefined;
  facilityId?: string | undefined;
  roomId?: string | undefined;
  bookingId?: string | undefined;
  status?: FacilityBookingStatus | undefined;
  open?: boolean | undefined;
}

export interface FacilityBookingService {
  create(actor: AuthenticatedStaff, input: CreateFacilityBookingInput): Promise<FacilityBookingDto>;
  list(input: ListFacilityBookingsInput): Promise<{ items: FacilityBookingDto[]; total: number }>;
  get(id: string): Promise<FacilityBookingDto>;
  summary(date: string): Promise<FacilityBookingSummaryDto>;
  confirm(id: string): Promise<FacilityBookingDto>;
  start(id: string): Promise<FacilityBookingDto>;
  complete(id: string): Promise<FacilityBookingDto>;
  noShow(id: string): Promise<FacilityBookingDto>;
  cancel(id: string, reason: string): Promise<FacilityBookingDto>;
}

const HOLDING = [...FACILITY_HOLDING_STATUSES];
const MAX_ATTEMPTS = 5;

function duplicateOn(error: unknown, field: string): boolean {
  const like = error as { code?: unknown; keyPattern?: Record<string, unknown> } | null;
  return like?.code === 11000 && like.keyPattern !== undefined && field in like.keyPattern;
}

const slotFull = (): ReturnType<typeof conflict> =>
  conflict('That slot is full. Please pick another time.', 'slot_full');

export function createFacilityBookingService(
  properties: PropertyService,
  bus: EventBus = eventBus,
): FacilityBookingService {
  const tenant = (): Types.ObjectId => {
    const id = getTenantId();
    if (!id) throw new Error('No tenant context');
    return id;
  };
  const timezone = async (): Promise<string> => (await properties.get(tenant())).timezone;

  async function load(id: string): Promise<FacilityBookingDocument> {
    const booking = await FacilityBooking.findOne({ _id: id }).lean();
    if (!booking) throw notFound('Facility booking not found');
    return booking;
  }

  /** Spa staff, the front desk and managers hear this. It carries no guest details. */
  function announce(booking: FacilityBookingDocument, change: string): void {
    bus.emit({
      type: 'facility_booking.changed',
      propertyId: booking.propertyId,
      audience: { departments: ['spa_recreation', 'front_desk'] },
      data: {
        facilityBookingId: booking._id.toHexString(),
        code: booking.code,
        facilityId: booking.facilityId.toHexString(),
        facilityName: booking.facilityName,
        roomId: booking.roomId.toHexString(),
        roomNumber: booking.roomNumber,
        date: booking.date,
        startTime: booking.startTime,
        status: booking.status,
        change,
      },
    });
  }

  async function audit(
    action: string,
    booking: FacilityBookingDocument,
    extra: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<void> {
    await recordAudit({
      action: `facility_booking.${action}`,
      target: { type: 'facility_booking', id: booking._id.toHexString() },
      summary: {
        code: booking.code,
        facilityId: booking.facilityId.toHexString(),
        date: booking.date,
        startTime: booking.startTime,
        totalPaise: booking.totalPaise,
        ...extra,
      },
      ...(session ? { session } : {}),
    });
  }

  /**
   * One legal step. The step, its audit entry and (for a cancellation) giving the places back to
   * the slot commit together, so a failure anywhere leaves everything as it was. Announcing
   * happens after the commit and cannot throw.
   */
  async function move(
    id: string,
    to: FacilityBookingStatus,
    change: string,
    set: Record<string, unknown>,
    options: { freeSlot?: boolean; reason?: string } = {},
  ): Promise<FacilityBookingDocument> {
    const booking = await inTransaction(async (session) => {
      const moved = await transition({
        model: FacilityBooking,
        id,
        machine: facilityBookingMachine,
        to,
        set,
        session,
        ...(options.reason ? { note: options.reason } : {}),
      });
      const updated = moved.toObject();
      if (options.freeSlot) {
        await FacilitySlot.updateOne(
          { facilityId: updated.facilityId, slotStart: updated.slotStart },
          { $inc: { booked: -updated.participants } },
          { session },
        );
      }
      await audit(change, updated, options.reason ? { reason: options.reason } : {}, session);
      return updated;
    });
    announce(booking, change);
    return booking;
  }

  return {
    async create(actor, input) {
      const facility = await Facility.findOne({ _id: input.facilityId }).lean();
      if (!facility) throw badRequest('That facility does not exist', 'unknown_facility');
      if (!facility.active) {
        throw conflict(`${facility.name} is not taking bookings`, 'facility_inactive');
      }

      const slot = findSlot(facility, input.startTime);
      if (!slot) {
        throw badRequest(
          `${facility.name} has no slot starting at ${input.startTime}`,
          'invalid_slot',
        );
      }
      const tz = await timezone();
      const slotStart = localDateTimeToUtc(input.date, slot.startTime, tz);
      const slotEnd = localDateTimeToUtc(input.date, slot.endTime, tz);
      if (slotStart.getTime() <= Date.now()) {
        throw conflict('That slot has already started', 'slot_in_past');
      }

      const room = await Room.findOne({ _id: input.roomId, active: true }).lean();
      if (!room) throw badRequest('That room does not exist', 'unknown_room');
      const stay = await Booking.findOne({ roomId: room._id, status: 'checked_in' }).lean();
      if (!stay) throw conflict(`Room ${room.number} has no guest checked in`, 'no_guest_in_room');
      // Once the invoice is issued nothing more can be added, or it could never be billed.
      if (await Bill.exists({ bookingId: stay._id, status: 'finalized' })) {
        throw conflict(
          'This guest’s invoice has already been issued, so nothing more can be booked',
          'invoice_issued',
        );
      }
      if (input.date < stay.checkInDate || input.date > stay.checkOutDate) {
        throw conflict(
          `The guest in room ${room.number} stays from ${stay.checkInDate} to ${stay.checkOutDate}`,
          'outside_stay',
        );
      }
      if (input.participants > facility.capacity) {
        throw conflict(
          `${facility.name} takes at most ${facility.capacity} ${facility.capacity === 1 ? 'person' : 'people'} at a time`,
          'too_many_participants',
        );
      }

      const principal = getContext()?.principal;
      const fields = {
        facilityId: facility._id,
        facilityName: facility.name,
        facilityType: facility.type,
        roomId: room._id,
        roomNumber: room.number,
        bookingId: stay._id,
        guestName: stay.guestSnapshot.name,
        date: input.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        slotStart,
        slotEnd,
        participants: input.participants,
        // The price comes from the facility as it is now. Nothing in the request is a price.
        unitPricePaise: facility.pricePaise,
        totalPaise: facility.pricePaise * input.participants,
        notes: input.notes,
        status: 'requested' as const,
        history: [
          { from: null, to: 'requested', at: new Date(), ...(principal ? { by: principal } : {}) },
        ],
        source:
          actor.role === 'spa_recreation' ? ('spa_recreation' as const) : ('front_desk' as const),
        createdBy: actor.id.toHexString(),
      };

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const booking = await inTransaction(async (session) => {
            // Take the places with one conditional update: it only applies while the slot still
            // has room, so two requests racing for the last place cannot both get it. A slot
            // that is full makes the upsert try to insert a second counter, which the unique
            // index refuses.
            await FacilitySlot.findOneAndUpdate(
              {
                facilityId: facility._id,
                slotStart,
                booked: { $lte: facility.capacity - input.participants },
              },
              { $inc: { booked: input.participants } },
              { upsert: true, session, returnDocument: 'after' },
            );
            const [created] = await FacilityBooking.create(
              [{ ...fields, code: generateReadableCode('FB') }],
              { session },
            );
            if (!created) throw new Error('Facility booking was not created');
            return created.toObject();
          });

          await audit('created', booking, { participants: booking.participants }, undefined);
          announce(booking, 'created');
          return toFacilityBookingDto(booking);
        } catch (error) {
          if (duplicateOn(error, 'code')) continue; // two bookings drew the same code: draw again
          if (duplicateOn(error, 'slotStart')) {
            // Either the slot really is full, or two first bookings raced to create its counter
            // and this one lost. Look at the counter to tell which.
            const row = await FacilitySlot.findOne({ facilityId: facility._id, slotStart }).lean();
            if (row && row.booked + input.participants > facility.capacity) throw slotFull();
            continue;
          }
          throw error;
        }
      }
      throw slotFull();
    },

    async list(input) {
      const filter: Record<string, unknown> = {};
      if (input.date) filter.date = input.date;
      if (input.facilityId) filter.facilityId = input.facilityId;
      if (input.roomId) filter.roomId = input.roomId;
      if (input.bookingId) filter.bookingId = input.bookingId;
      if (input.status) filter.status = input.status;
      if (input.open) filter.status = { $in: HOLDING };

      const [items, total] = await Promise.all([
        FacilityBooking.find(filter)
          .sort({ slotStart: 1, code: 1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        FacilityBooking.countDocuments(filter),
      ]);
      return { items: items.map(toFacilityBookingDto), total };
    },

    async get(id) {
      return toFacilityBookingDto(await load(id));
    },

    async summary(date) {
      const rows = await FacilityBooking.aggregate<{
        _id: FacilityBookingStatus;
        count: number;
        people: number;
      }>([
        { $match: { date } },
        { $group: { _id: '$status', count: { $sum: 1 }, people: { $sum: '$participants' } } },
      ]);
      const byStatus = Object.fromEntries(FACILITY_BOOKING_STATUSES.map((status) => [status, 0]));
      let participantsExpected = 0;
      for (const row of rows) {
        byStatus[row._id] = row.count;
        if (HOLDING.includes(row._id)) participantsExpected += row.people;
      }
      return { date, byStatus, participantsExpected };
    },

    async confirm(id) {
      return toFacilityBookingDto(
        await move(id, 'confirmed', 'confirmed', { confirmedAt: new Date() }),
      );
    },

    async start(id) {
      return toFacilityBookingDto(await move(id, 'active', 'started', { startedAt: new Date() }));
    },

    async complete(id) {
      const booking = await move(id, 'completed', 'completed', { completedAt: new Date() });
      // Only the caller whose update really moved the booking gets here, so billing hears it once.
      bus.emit({
        type: 'facility_booking.completed',
        propertyId: booking.propertyId,
        // No screen needs this. Billing listens on the bus itself (P1.10).
        audience: { managers: false },
        data: {
          facilityBookingId: booking._id.toHexString(),
          bookingId: booking.bookingId.toHexString(),
          roomId: booking.roomId.toHexString(),
          facilityName: booking.facilityName,
          facilityType: booking.facilityType,
          date: booking.date,
          participants: booking.participants,
          totalPaise: booking.totalPaise,
        },
      });
      return toFacilityBookingDto(booking);
    },

    async noShow(id) {
      const current = await load(id);
      // A no-show only makes sense once the slot has started. (A booking that was never confirmed
      // fails the state machine below with a clearer message.)
      if (
        canTransition(facilityBookingMachine, current.status, 'no_show') &&
        current.slotStart.getTime() > Date.now()
      ) {
        throw conflict('The slot has not started yet, so this cannot be a no-show', 'too_early');
      }
      return toFacilityBookingDto(await move(id, 'no_show', 'no_show', {}));
    },

    async cancel(id, reason) {
      return toFacilityBookingDto(
        await move(
          id,
          'cancelled',
          'cancelled',
          { cancelReason: reason, cancelledAt: new Date() },
          {
            freeSlot: true,
            reason,
          },
        ),
      );
    },
  };
}
