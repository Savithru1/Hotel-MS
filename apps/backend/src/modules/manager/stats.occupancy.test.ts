import type { OccupancyDayDto } from '@hospitality/shared-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { day, today } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { clientFor, plantBooking, roomIdsOf } from '../../../test/manager';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Room } from '../rooms/room.model';

useTestDatabase();

const t = buildTestApp();
let a: SeededProperty;
let b: SeededProperty;
let manager: Client;
let roomsA: Awaited<ReturnType<typeof roomIdsOf>>;
let roomsB: Awaited<ReturnType<typeof roomIdsOf>>;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await clientFor(t, a, 'manager');
  roomsA = await roomIdsOf(a);
  roomsB = await roomIdsOf(b);
});

const query = (from: string, to: string, client: Client = manager) =>
  client.get(`/api/v1/manager/stats/occupancy?from=${from}&to=${to}`);

describe('GET /manager/stats/occupancy: bookings on the books', () => {
  it('counts the nights of each day, leaves out cancelled bookings and other properties', async () => {
    const D = day(10);
    const D1 = day(11);
    const D2 = day(12);
    // Night D: three rooms. Night D+1: one room.
    await plantBooking(a, {
      status: 'confirmed',
      roomId: roomsA[0]!,
      checkInDate: D,
      checkOutDate: D1,
    });
    await plantBooking(a, {
      status: 'pending',
      roomId: roomsA[1]!,
      checkInDate: D,
      checkOutDate: D1,
    });
    await plantBooking(a, {
      status: 'confirmed',
      roomId: roomsA[2]!,
      checkInDate: D,
      checkOutDate: D2,
    });
    // A cancelled booking whose nights were (wrongly) left behind must not be counted.
    await plantBooking(a, {
      status: 'cancelled',
      roomId: roomsA[3]!,
      checkInDate: D,
      checkOutDate: D2,
    });
    // Another property's booking on the same night.
    await plantBooking(b, {
      status: 'confirmed',
      roomId: roomsB[0]!,
      checkInDate: D,
      checkOutDate: D1,
    });

    const res = await query(D, D1);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.from).toBe(D);
    expect(res.body.data.to).toBe(D1);
    expect(res.body.data.days).toEqual([
      { date: D, occupied: 3, sellable: 10, rateBp: 3000, basis: 'on_the_books' },
      { date: D1, occupied: 1, sellable: 10, rateBp: 1000, basis: 'on_the_books' },
    ] satisfies OccupancyDayDto[]);
  });

  it('shows every day of the range, including empty ones', async () => {
    const res = await query(day(30), day(32));
    expect(res.body.data.days).toEqual([
      { date: day(30), occupied: 0, sellable: 10, rateBp: 0, basis: 'on_the_books' },
      { date: day(31), occupied: 0, sellable: 10, rateBp: 0, basis: 'on_the_books' },
      { date: day(32), occupied: 0, sellable: 10, rateBp: 0, basis: 'on_the_books' },
    ]);
  });
});

describe('GET /manager/stats/occupancy: past days and today', () => {
  it('counts only stays that really happened on past days', async () => {
    const P = day(-20);
    const P1 = day(-19);
    await plantBooking(a, {
      status: 'checked_out',
      roomId: roomsA[0]!,
      checkInDate: P,
      checkOutDate: P1,
    });
    await plantBooking(a, {
      status: 'checked_in',
      roomId: roomsA[1]!,
      checkInDate: P,
      checkOutDate: P1,
    });
    // Never arrived: not an occupied room-night.
    await plantBooking(a, {
      status: 'confirmed',
      roomId: roomsA[2]!,
      checkInDate: P,
      checkOutDate: P1,
    });
    await plantBooking(a, {
      status: 'no_show',
      roomId: roomsA[3]!,
      checkInDate: P,
      checkOutDate: P1,
    });

    const res = await query(P, P);
    expect(res.body.data.days).toEqual([
      { date: P, occupied: 2, sellable: 10, rateBp: 2000, basis: 'actual' },
    ]);
  });

  it('counts a checked-in guest today (actual) and tomorrow (on the books), but not an arrival that has not checked in', async () => {
    await plantBooking(a, {
      status: 'checked_in',
      roomId: roomsA[4]!,
      checkInDate: today(),
      checkOutDate: day(2),
    });
    await plantBooking(a, {
      status: 'confirmed',
      roomId: roomsA[5]!,
      checkInDate: today(),
      checkOutDate: day(1),
    });

    const res = await query(today(), day(1));
    expect(res.body.data.days).toEqual([
      { date: today(), occupied: 1, sellable: 10, rateBp: 1000, basis: 'actual' },
      { date: day(1), occupied: 1, sellable: 10, rateBp: 1000, basis: 'on_the_books' },
    ]);
  });
});

describe('GET /manager/stats/occupancy: defaults and limits', () => {
  it('defaults to today when no dates are given', async () => {
    const res = await manager.get('/api/v1/manager/stats/occupancy');
    expect(res.status).toBe(200);
    expect(res.body.data.from).toBe(today());
    expect(res.body.data.to).toBe(today());
    expect(res.body.data.days).toHaveLength(1);
  });

  it('refuses a backwards range, a range over 92 days and bad dates', async () => {
    expect((await query(day(5), day(4))).status).toBe(400);
    expect((await query(day(0), day(92))).status).toBe(400);
    expect((await query(day(0), day(91))).status).toBe(200);
    expect((await manager.get('/api/v1/manager/stats/occupancy?from=nope')).status).toBe(400);
  });
});

describe('GET /manager/stats/occupancy: the room count', () => {
  it('uses active rooms only, and gives no rate when there are none to sell', async () => {
    const D = day(40);
    await plantBooking(b, {
      status: 'confirmed',
      roomId: roomsB[0]!,
      checkInDate: D,
      checkOutDate: day(41),
    });
    const managerB = await clientFor(t, b, 'manager');

    // One room is taken out of the list of rooms: 1 of 9, which rounds to 1111 basis points.
    await runWithTenant(b.id, () =>
      Room.updateOne({ _id: roomsB[9]! }, { $set: { active: false } }),
    );
    expect((await query(D, D, managerB)).body.data.days).toEqual([
      { date: D, occupied: 1, sellable: 9, rateBp: 1111, basis: 'on_the_books' },
    ]);

    // No active rooms at all: nothing to divide by, so the rate is null (never 0 or NaN).
    await runWithTenant(b.id, () => Room.updateMany({}, { $set: { active: false } }));
    expect((await query(D, D, managerB)).body.data.days).toEqual([
      { date: D, occupied: 1, sellable: 0, rateBp: null, basis: 'on_the_books' },
    ]);
  });
});
