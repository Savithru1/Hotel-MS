import { isManagementRole } from '@hospitality/constants';
import type { CheckOutResultDto } from '@hospitality/shared-types';
import type { Types } from 'mongoose';
import { recordAudit } from '../../shared/audit/audit';
import { todayIn } from '../../shared/dates';
import { conflict, forbidden, notFound } from '../../shared/errors';
import { eventBus, type EventBus } from '../../shared/events/event-bus';
import { getTenantId } from '../../shared/request-context';
import { transition } from '../../shared/state-machine';
import { inTransaction } from '../../shared/transaction';
import type { AuthenticatedStaff } from '../auth/auth.types';
import { bookingStatusMachine } from '../bookings/booking-status';
import { Booking } from '../bookings/booking.model';
import { RoomNight } from '../bookings/room-night.model';
import type { PropertyService } from '../properties/property.service';
import { announceRoomStatus, type RoomService } from '../rooms/room.service';
import { Room } from '../rooms/room.model';
import { ServiceRequest } from '../service-requests/service-request.model';
import type { BillingService } from './billing.service';

export interface CheckOutService {
  checkOut(
    actor: AuthenticatedStaff,
    bookingId: string,
    input: { overrideReason?: string | undefined },
  ): Promise<CheckOutResultDto>;
}

const isManager = (actor: AuthenticatedStaff): boolean =>
  isManagementRole(actor.role) || actor.role === 'platform_admin';

/**
 * Check-out is one step: the invoice, the booking, the room, the cleaning task and the audit entry
 * are saved together or not at all. A guest is never checked out with a half-finished bill, and a
 * room is never left occupied after the guest has gone.
 */
export function createCheckOutService(
  properties: PropertyService,
  billing: BillingService,
  rooms: Pick<RoomService, 'changeStatus'>,
  bus: EventBus = eventBus,
): CheckOutService {
  const tenant = (): Types.ObjectId => {
    const id = getTenantId();
    if (!id) throw new Error('No tenant context');
    return id;
  };

  return {
    async checkOut(actor, bookingId, input) {
      // Only a manager may let a guest leave with an unsettled balance.
      if (input.overrideReason && !isManager(actor)) {
        throw forbidden(
          'Only a manager can check a guest out with an unsettled balance',
          'manager_override_required',
        );
      }

      const booking = await Booking.findOne({ _id: bookingId }).lean();
      if (!booking) throw notFound('Booking not found');
      if (booking.status !== 'checked_in') {
        throw conflict(
          booking.status === 'checked_out'
            ? 'This guest has already checked out'
            : 'This guest is not checked in',
          booking.status === 'checked_out' ? 'already_checked_out' : 'not_checked_in',
        );
      }

      const openItems = await billing.openItemsProblem(booking._id);
      if (openItems) throw conflict(openItems, 'open_items');

      const existing = await billing.ensureBill(booking);
      if (
        existing.status === 'finalized' &&
        (await billing.unbilledItemCount(existing, booking)) > 0
      ) {
        throw conflict(
          'An order or booking was completed after the invoice was issued. Correct the invoice with a credit note or contact a manager before checking out.',
          'unbilled_items',
        );
      }
      await billing.prepareInvoiceCounter();

      const timezone = (await properties.get(tenant())).timezone;
      const today = todayIn(timezone);
      const room = await Room.findOne({ _id: booking.roomId }).lean();
      if (!room) throw notFound('Room not found');

      const result = await inTransaction(async (session) => {
        const { bill, balancePaise } = await billing.finalizeForCheckout(session, actor, booking);

        if (balancePaise !== 0 && !input.overrideReason) {
          throw conflict(
            balancePaise > 0
              ? 'The bill is not fully paid'
              : 'The guest has paid more than the bill, a refund is due',
            balancePaise > 0 ? 'unpaid_balance' : 'refund_due',
            { balancePaise },
          );
        }

        const checkedOutAt = new Date();
        const moved = await transition({
          model: Booking,
          id: booking._id,
          machine: bookingStatusMachine,
          to: 'checked_out',
          set: { checkedOutAt },
          session,
        });

        // Nights from today on are not used, so they go back on sale. Past nights stay as they were.
        await RoomNight.deleteMany({ bookingId: booking._id, night: { $gte: today } }, { session });

        let roomPrevious = room.status;
        if (room.status === 'occupied') {
          await rooms.changeStatus(room._id.toHexString(), 'cleaning', { session });
        } else {
          roomPrevious = room.status;
        }

        const [task] = await ServiceRequest.create(
          [
            {
              type: 'room_cleaning',
              roomId: room._id,
              bookingId: booking._id,
              guestName: booking.guestSnapshot.name,
              notes: `Check-out of ${booking.bookingCode}`,
              priority: 'normal',
              priorityRank: 0,
              source: 'system',
              createdBy: 'system',
              history: [
                { from: null, to: 'new', at: checkedOutAt, by: { kind: 'system', id: 'system' } },
              ],
            },
          ],
          { session },
        );

        await recordAudit({
          action: 'booking.checked_out',
          target: { type: 'booking', id: bookingId },
          summary: {
            bookingCode: booking.bookingCode,
            roomId: room._id.toHexString(),
            invoiceNumber: bill.invoice?.number ?? null,
            balancePaise,
            overrideReason: input.overrideReason ?? null,
          },
          session,
        });
        return { moved: moved.toObject(), checkedOutAt, task, roomPrevious };
      });

      const { moved, checkedOutAt, task, roomPrevious } = result;
      bus.emit({
        type: 'booking.changed',
        propertyId: moved.propertyId,
        audience: { departments: ['front_desk'] },
        data: {
          bookingId,
          bookingCode: moved.bookingCode,
          status: moved.status,
          roomId: moved.roomId.toHexString(),
          change: 'checked_out',
        },
      });
      if (room.status === 'occupied') {
        announceRoomStatus(bus, moved.propertyId, room._id, room.number, 'cleaning', roomPrevious);
      }
      if (task) {
        bus.emit({
          type: 'housekeeping.changed',
          propertyId: moved.propertyId,
          audience: { departments: ['housekeeping', 'front_desk'] },
          data: {
            requestId: task._id.toHexString(),
            roomId: room._id.toHexString(),
            roomNumber: room.number,
            status: task.status,
            change: 'created',
            escalated: false,
            // A cleaning task made at check-out starts unassigned.
            assignedTo: null,
          },
        });
      }

      const finalBill = await billing.ensureBill(moved);
      return {
        bookingId,
        bookingCode: moved.bookingCode,
        roomNumber: room.number,
        status: 'checked_out',
        checkedOutAt: checkedOutAt.toISOString(),
        bill: await billing.assemble(finalBill),
      };
    },
  };
}
