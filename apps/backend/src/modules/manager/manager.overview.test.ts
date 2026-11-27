import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { clientFor, plantBooking, roomIdsOf } from '../../../test/manager';
import { addDays, localDateTimeToUtc, todayIn } from '../../shared/dates';
import { runAsPlatform, runWithTenant } from '../../shared/request-context';
import { FacilityBooking } from '../facilities/facility-booking.model';
import { FoodOrder } from '../food-orders/food-order.model';
import { MaintenanceIssue } from '../maintenance/maintenance.model';
import { Property } from '../properties/property.model';
import { Room } from '../rooms/room.model';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { ServiceRequest } from '../service-requests/service-request.model';

useTestDatabase();

const IST = 'Asia/Kolkata';
const LA = 'America/Los_Angeles';
const O = '2026-06-10';
const t = buildTestApp();
let a: SeededProperty;
let b: SeededProperty;
let manager: Client;
let rooms: Types.ObjectId[];

const SECOND = 1000;
const local = (date: string, time: string, tz = IST): Date => localDateTimeToUtc(date, time, tz);
const before = (instant: Date): Date => new Date(instant.getTime() - SECOND);

async function setRoomStatus(index: number, status: string, active = true): Promise<void> {
  await runWithTenant(a.id, () =>
    Room.updateOne({ _id: rooms[index] }, { $set: { status, active } }),
  );
}

let code = 0;
const order = (plan: Record<string, unknown>) =>
  runWithTenant(a.id, () =>
    FoodOrder.create({
      code: `OV-${++code}`,
      roomId: rooms[0],
      roomNumber: '101',
      bookingId: new Types.ObjectId(),
      guestName: 'Guest',
      items: [
        {
          menuItemId: new Types.ObjectId(),
          name: 'Tea',
          quantity: 1,
          unitPricePaise: 5000,
          lineTotalPaise: 5000,
        },
      ],
      subtotalPaise: 5000,
      ...plan,
    }),
  );

const spa = (plan: Record<string, unknown>) =>
  runWithTenant(a.id, () =>
    FacilityBooking.create({
      code: `SP-${++code}`,
      facilityId: new Types.ObjectId(),
      facilityName: 'Spa',
      facilityType: 'spa',
      roomId: rooms[0],
      roomNumber: '101',
      bookingId: new Types.ObjectId(),
      guestName: 'Guest',
      date: O,
      startTime: '10:00',
      endTime: '11:00',
      slotStart: local(O, '10:00'),
      slotEnd: local(O, '11:00'),
      participants: 1,
      unitPricePaise: 100_000,
      totalPaise: 100_000,
      ...plan,
    }),
  );

const request = (property: SeededProperty, roomId: Types.ObjectId, plan: Record<string, unknown>) =>
  runWithTenant(property.id, () =>
    ServiceRequest.create({ type: 'room_cleaning', roomId, ...plan }),
  );

const issue = (plan: Record<string, unknown>) =>
  runWithTenant(a.id, () =>
    MaintenanceIssue.create({
      category: 'plumbing',
      description: 'Leak',
      roomId: rooms[1],
      ...plan,
    }),
  );

async function plantFloor(): Promise<void> {
  await setRoomStatus(0, 'occupied');
  await setRoomStatus(1, 'occupied');
  await setRoomStatus(2, 'cleaning');
  await setRoomStatus(3, 'out_of_service');
  await setRoomStatus(9, 'cleaning', false); // not an active room: left out of every count

  const stay = (
    index: number,
    status: 'pending' | 'confirmed' | 'checked_in' | 'checked_out' | 'cancelled' | 'no_show',
    checkInDate: string,
    checkOutDate: string,
  ) => plantBooking(a, { status, roomId: rooms[index]!, checkInDate, checkOutDate });
  // Arrivals on O: three expected, one has checked in. A cancelled and a no-show one do not count.
  await stay(0, 'checked_in', O, addDays(O, 2));
  await stay(4, 'confirmed', O, addDays(O, 1));
  await stay(5, 'pending', O, addDays(O, 1));
  await stay(6, 'cancelled', O, addDays(O, 1));
  await stay(7, 'no_show', O, addDays(O, 1));
  // Already in the house since before O.
  await stay(1, 'checked_in', addDays(O, -2), addDays(O, 1));
  // Departures on O: one has left, one is still in the house.
  await stay(8, 'checked_out', addDays(O, -2), O);
  await stay(2, 'checked_in', addDays(O, -1), O);
}

async function plantQueues(): Promise<void> {
  const midnight = local(O, '00:00');
  const nextMidnight = local(addDays(O, 1), '00:00');

  // Housekeeping: three open (one escalated, two urgent). Four finished around local midnight.
  await request(a, rooms[0]!, { status: 'new', priority: 'normal' });
  await request(a, rooms[1]!, {
    status: 'in_progress',
    priority: 'urgent',
    escalated: true,
    escalationReason: 'Guest is waiting',
    escalatedAt: local(O, '09:00'),
  });
  await request(a, rooms[2]!, { status: 'new', priority: 'urgent' });
  // An escalated request that is already finished is not a live escalation.
  await request(a, rooms[2]!, {
    status: 'completed',
    escalated: true,
    escalatedAt: local(O, '08:00'),
    completedAt: local(O, '12:00'),
  });
  for (const completedAt of [before(midnight), midnight, before(nextMidnight), nextMidnight]) {
    await request(a, rooms[3]!, { status: 'completed', completedAt });
  }

  // Maintenance: three open (one escalated, one urgent). Two resolved, one inside the day.
  await issue({ status: 'new', priority: 'high' });
  await issue({
    status: 'assigned',
    priority: 'urgent',
    escalated: true,
    escalationReason: 'Water on the floor',
    escalatedAt: local(O, '10:30'),
  });
  await issue({ status: 'in_progress', priority: 'low' });
  await issue({ status: 'resolved', resolvedAt: local(O, '12:00') });
  await issue({ status: 'resolved', resolvedAt: nextMidnight });

  // Kitchen: three open orders; one delivered inside the day, one just before it.
  await order({ status: 'received' });
  await order({ status: 'preparing' });
  await order({ status: 'ready' });
  await order({ status: 'delivered', deliveredAt: local(O, '10:00') });
  await order({ status: 'delivered', deliveredAt: before(midnight) });

  // Spa: three bookings holding a place; one finished inside the day, one just after it.
  await spa({ status: 'requested' });
  await spa({ status: 'confirmed' });
  await spa({ status: 'active' });
  await spa({ status: 'completed', completedAt: local(O, '15:00') });
  await spa({ status: 'completed', completedAt: nextMidnight });
  await spa({ status: 'cancelled' });
}

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await clientFor(t, a, 'manager');
  rooms = await roomIdsOf(a);
  await runAsPlatform(() => Property.updateOne({ _id: b.id }, { $set: { timezone: LA } }));
  await plantFloor();
  await plantQueues();
});

const overview = (date: string | null = O, client: Client = manager) =>
  client.get(`/api/v1/manager/overview${date ? `?date=${date}` : ''}`);

describe('GET /manager/overview: rooms, arrivals and occupancy', () => {
  it('counts active rooms by status and leaves out inactive rooms', async () => {
    const { data } = (await overview()).body;
    expect(data.date).toBe(O);
    expect(data.timezone).toBe(IST);
    expect(data.rooms).toEqual({
      active: 9,
      byStatus: {
        available: 5,
        occupied: 2,
        reserved: 0,
        cleaning: 1,
        maintenance: 0,
        out_of_service: 1,
      },
    });
  });

  it('shows arrivals and departures expected and done, and who is in the house', async () => {
    const { data } = (await overview()).body;
    expect(data.arrivals).toEqual({ expected: 3, checkedIn: 1 });
    expect(data.departures).toEqual({ expected: 2, checkedOut: 1 });
    // Checked in right now: the arrival, the long stay and the guest still due to leave.
    expect(data.inHouse).toBe(3);
  });

  it('shows occupancy of the date from the room nights', async () => {
    const { data } = (await overview()).body;
    // Nights on O: the arrival and the long stay. 2 of 9 active rooms = 2222 basis points.
    expect(data.occupancy).toEqual({ occupied: 2, sellable: 9, rateBp: 2222 });
  });
});

describe('GET /manager/overview: queues', () => {
  it('counts work still open, finished during the local day, escalated and urgent', async () => {
    const { queues } = (await overview()).body.data;
    // Finished at 00:00:00 and 23:59:59 local count. One second before and at the next midnight do not.
    expect(queues.housekeeping).toEqual({ pending: 3, completedToday: 3, escalated: 1, urgent: 2 });
    expect(queues.maintenance).toEqual({ pending: 3, completedToday: 1, escalated: 1, urgent: 1 });
    expect(queues.kitchen).toEqual({ pending: 3, completedToday: 1, escalated: 0, urgent: 0 });
    expect(queues.spa).toEqual({ pending: 3, completedToday: 1, escalated: 0, urgent: 0 });
  });

  it('lists the open escalations, newest first, with the room number', async () => {
    const { escalations } = (await overview()).body.data;
    expect(escalations).toEqual([
      {
        kind: 'maintenance',
        id: expect.any(String),
        roomNumber: '102',
        reason: 'Water on the floor',
        escalatedAt: local(O, '10:30').toISOString(),
        priority: 'urgent',
      },
      {
        kind: 'housekeeping',
        id: expect.any(String),
        roomNumber: '102',
        reason: 'Guest is waiting',
        escalatedAt: local(O, '09:00').toISOString(),
        priority: 'urgent',
      },
    ]);
  });
});

describe('GET /manager/overview: the property-local day', () => {
  it.each([
    ['a property in India (UTC+5:30)', 'a', IST],
    ['a property in California (UTC-7)', 'b', LA],
  ] as const)('decides "completed today" in the timezone of %s', async (_name, which, tz) => {
    const property = which === 'a' ? a : b;
    const client = await clientFor(t, property, 'manager');
    const date = '2026-07-01';
    const midnight = local(date, '00:00', tz);
    const nextMidnight = local(addDays(date, 1), '00:00', tz);
    const room = (await roomIdsOf(property))[5]!;
    // Before start of the day, first and last second of the day, first second of the next day.
    for (const completedAt of [before(midnight), midnight, before(nextMidnight), nextMidnight]) {
      await request(property, room, { status: 'completed', completedAt });
    }

    const res = await overview(date, client);
    expect(res.body.data.timezone).toBe(tz);
    expect(res.body.data.queues.housekeeping.completedToday).toBe(2);
    // The day before holds the one second before midnight (and nothing else).
    const previous = await overview(addDays(date, -1), client);
    expect(previous.body.data.queues.housekeeping.completedToday).toBe(1);
  });

  it('uses today in the property timezone when no date is given', async () => {
    const { data } = (await overview(null)).body;
    expect(data.date).toBe(todayIn(IST));
    const other = (await overview(null, await clientFor(t, b, 'manager'))).body.data;
    expect(other.date).toBe(todayIn(LA));
    expect(other.timezone).toBe(LA);
  });

  it('refuses a malformed date', async () => {
    expect((await overview('10-06-2026')).status).toBe(400);
    expect((await overview('2026-02-31')).status).toBe(400);
  });
});

describe('GET /manager/overview: other properties', () => {
  it('shows a property only its own numbers', async () => {
    const { data } = (await overview(O, await clientFor(t, b, 'manager'))).body;
    expect(data.rooms.active).toBe(10);
    expect(data.arrivals).toEqual({ expected: 0, checkedIn: 0 });
    expect(data.inHouse).toBe(0);
    expect(data.queues.maintenance).toEqual({
      pending: 0,
      completedToday: 0,
      escalated: 0,
      urgent: 0,
    });
    expect(data.escalations).toEqual([]);
  });
});
