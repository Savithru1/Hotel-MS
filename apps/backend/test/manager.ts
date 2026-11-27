import type { BookingStatus, GstCategory, StaffRole } from '@hospitality/constants';
import { Types } from 'mongoose';
import { Bill, type BillLineDocument } from '../src/modules/billing/bill.model';
import { Booking } from '../src/modules/bookings/booking.model';
import { RoomNight } from '../src/modules/bookings/room-night.model';
import { Room } from '../src/modules/rooms/room.model';
import type { SeededProperty } from '../src/modules/seed/seed';
import { nightsOf } from '../src/shared/dates';
import { runWithTenant } from '../src/shared/request-context';
import type { Client, TestApp } from './http';

let counter = 0;
const next = (): number => ++counter;

export function clientFor(t: TestApp, property: SeededProperty, role: StaffRole): Promise<Client> {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role} in ${property.slug}`);
  return t.actAs(staff.id, property.id);
}

/** The ids of a property's active rooms, in room-number order. */
export async function roomIdsOf(property: SeededProperty): Promise<Types.ObjectId[]> {
  const rooms = await runWithTenant(property.id, () =>
    Room.find({ active: true }, { _id: 1 }).sort({ number: 1 }).lean(),
  );
  return rooms.map((room) => room._id);
}

export interface PlantedBooking {
  id: Types.ObjectId;
  roomId: Types.ObjectId;
}

export interface BookingPlan {
  status: BookingStatus;
  roomId: Types.ObjectId;
  checkInDate: string;
  checkOutDate: string;
  /** Plant the room nights too (default). A real cancelled booking has none; tests may add them. */
  withNights?: boolean;
  checkedInAt?: Date | null;
}

/** Writes a booking and, unless told not to, the room nights it holds. */
export async function plantBooking(
  property: SeededProperty,
  plan: BookingPlan,
): Promise<PlantedBooking> {
  const n = next();
  const nights = nightsOf(plan.checkInDate, plan.checkOutDate);
  const created = await runWithTenant(property.id, async () => {
    const booking = await Booking.create({
      bookingCode: `MGR-${n}`,
      guestId: new Types.ObjectId(),
      guestSnapshot: { name: `Guest ${n}`, phone: `+9190000${String(n).padStart(5, '0')}` },
      roomTypeId: new Types.ObjectId(),
      roomId: plan.roomId,
      checkInDate: plan.checkInDate,
      checkOutDate: plan.checkOutDate,
      nights: nights.length,
      adults: 1,
      nightlyRatePaise: 100_000,
      status: plan.status,
      checkedInAt: plan.checkedInAt ?? null,
    });
    if (plan.withNights !== false) {
      await RoomNight.insertMany(
        nights.map((night) => ({
          roomId: plan.roomId,
          night,
          bookingId: booking._id,
        })),
      );
    }
    return booking;
  });
  return { id: created._id, roomId: plan.roomId };
}

export interface LinePlan {
  lineId: string;
  category: GstCategory;
  kind?: BillLineDocument['kind'];
  serviceDate: string;
  taxablePaise: number;
  ratePercent: number;
  taxPaise: number;
}

/** A bill line with hand-written figures (no tax engine involved). */
export function line(plan: LinePlan): BillLineDocument {
  return {
    lineId: plan.lineId,
    kind:
      plan.kind ??
      (plan.category === 'room' ? 'room' : plan.category === 'food' ? 'food' : 'charge'),
    sourceKey: `test:${plan.lineId}`,
    category: plan.category,
    description: `Line ${plan.lineId}`,
    serviceDate: plan.serviceDate,
    quantity: 1,
    unitPaise: Math.abs(plan.taxablePaise),
    taxablePaise: plan.taxablePaise,
    ratePercent: plan.ratePercent,
    cgstPaise: Math.trunc(plan.taxPaise / 2),
    sgstPaise: plan.taxPaise - Math.trunc(plan.taxPaise / 2),
    igstPaise: 0,
    taxPaise: plan.taxPaise,
    totalPaise: plan.taxablePaise + plan.taxPaise,
    sacCode: '999799',
    ruleEffectiveFrom: '2020-01-01',
    reason: null,
    addedBy: null,
    approvedBy: null,
    postedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

export async function plantBill(
  property: SeededProperty,
  bookingId: Types.ObjectId,
  lines: BillLineDocument[],
): Promise<Types.ObjectId> {
  const n = next();
  const created = await runWithTenant(property.id, () =>
    Bill.create({
      bookingId,
      bookingCode: `MGR-BILL-${n}`,
      guestName: 'Guest',
      guestPhone: '+919000000000',
      intraState: true,
      roomNumber: '101',
      nightlyRatePaise: 100_000,
      checkInDate: '2026-01-01',
      checkOutDate: '2026-01-03',
      lines,
    }),
  );
  return created._id;
}
