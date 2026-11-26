import { STAFF_ROLES, type StaffRole } from '@hospitality/constants';
import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { addDays, todayIn } from '../../shared/dates';
import { eventBus, type DomainEvent } from '../../shared/events/event-bus';
import { runAsPlatform, runWithTenant } from '../../shared/request-context';
import { Property } from '../properties/property.model';
import { Room } from '../rooms/room.model';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Booking } from './booking.model';
import { RoomNight } from './room-night.model';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
const t = buildTestApp();

const TZ = 'Asia/Kolkata';
const today = (): string => todayIn(TZ);
const day = (offset: number): string => addDays(today(), offset);

const types: Record<string, string> = {};
const roomIds: Record<string, string> = {};

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

let desk: Client;
let manager: Client;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  desk = await as(a, 'front_desk');
  manager = await as(a, 'manager');
  const typeList = (await desk.get('/api/v1/room-types')).body.data as {
    id: string;
    name: string;
  }[];
  for (const type of typeList) types[type.name] = type.id;
  const roomList = (await desk.get('/api/v1/rooms?limit=100')).body.data as {
    id: string;
    number: string;
  }[];
  for (const room of roomList) roomIds[room.number] = room.id;
});

let phoneCounter = 0;
const nextPhone = (): string => `+9170000${String(10000 + ++phoneCounter)}`;

/** A fresh far-future window per call so tests never collide on the same nights. */
let windowCounter = 0;
function freshWindow(nights = 2): { checkInDate: string; checkOutDate: string } {
  const start = 200 + ++windowCounter * 7;
  return { checkInDate: day(start), checkOutDate: day(start + nights) };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guest: { name: 'Test Guest', phone: nextPhone() },
    roomTypeId: types.Standard,
    ...freshWindow(),
    adults: 2,
    ...overrides,
  };
}

async function book(overrides: Record<string, unknown> = {}, client: Client = desk) {
  return client.post('/api/v1/bookings', body(overrides));
}

describe('creating a booking', () => {
  it('holds the room for the nights, with a code, status, snapshot rate and estimate', async () => {
    const window = freshWindow(3);
    const res = await book({ ...window, roomId: roomIds['101'] });
    expect(res.status).toBe(201);
    const booking = res.body.data;
    expect(booking).toMatchObject({
      status: 'confirmed',
      roomNumber: '101',
      roomTypeName: 'Standard',
      nights: 3,
      nightlyRatePaise: 250_000,
      roomTotalPaise: 750_000,
      source: 'front_desk',
      checkedInAt: null,
    });
    expect(booking.bookingCode).toMatch(/^BK-[A-HJKMNP-Z2-9]{6}$/);

    const nights = await runWithTenant(a.id, () =>
      RoomNight.find({ bookingId: booking.id }).sort({ night: 1 }).lean(),
    );
    expect(nights.map((n) => n.night)).toEqual([
      window.checkInDate,
      addDays(window.checkInDate, 1),
      addDays(window.checkInDate, 2),
    ]);
  });

  it('picks the lowest-numbered free room when none is named', async () => {
    const window = freshWindow();
    const first = await book(window);
    const second = await book(window);
    const third = await book(window);
    expect([first, second, third].map((r) => r.body.data.roomNumber)).toEqual([
      '101',
      '102',
      '103',
    ]);
  });

  it('finds an existing guest by phone instead of creating a duplicate, and snapshots details', async () => {
    const phone = nextPhone();
    const one = await book({ guest: { name: 'Repeat Guest', phone } });
    const two = await book({ guest: { name: 'Repeat Guest', phone: phone.replace('+91', '0') } });
    expect(two.body.data.guest.id).toBe(one.body.data.guest.id);
    const known = await desk.get(`/api/v1/guests/${one.body.data.guest.id}`);
    expect(known.body.data.phone).toBe(phone);
  });

  it('can book for an existing guest by id', async () => {
    const guest = (await desk.post('/api/v1/guests', { name: 'Listed Guest', phone: nextPhone() }))
      .body.data;
    const res = await book({ guest: undefined, guestId: guest.id });
    expect(res.status).toBe(201);
    expect(res.body.data.guest).toMatchObject({ id: guest.id, name: 'Listed Guest' });
  });

  it('can create a pending booking, which does not yet count as confirmed', async () => {
    const res = await book({ status: 'pending' });
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.history).toBeUndefined();
  });

  it('ignores status-like fields, code, rate and propertyId sent by the client', async () => {
    const res = await book({
      bookingCode: 'BK-AAAAAA',
      nightlyRatePaise: 1,
      propertyId: b.id.toHexString(),
      checkedInAt: new Date().toISOString(),
      source: 'online',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.bookingCode).not.toBe('BK-AAAAAA');
    expect(res.body.data.nightlyRatePaise).toBe(250_000);
    expect(res.body.data.checkedInAt).toBeNull();
    expect(await runWithTenant(b.id, () => Booking.countDocuments({ _id: res.body.data.id }))).toBe(
      0,
    );
  });

  it.each([
    [
      'a check-in date in the past',
      () => ({ checkInDate: day(-1), checkOutDate: day(1) }),
      'date_in_past',
    ],
    [
      'a stay that ends before it starts',
      () => ({ checkInDate: day(300), checkOutDate: day(299) }),
      undefined,
    ],
    ['a zero-night stay', () => ({ checkInDate: day(300), checkOutDate: day(300) }), undefined],
    ['a stay over 90 nights', () => ({ checkInDate: day(300), checkOutDate: day(391) }), undefined],
    ['a fake date', () => ({ checkInDate: '2026-02-30' }), undefined],
    ['too many guests for the room type', () => ({ adults: 2, children: 1 }), 'over_capacity'],
    ['no guest at all', () => ({ guest: undefined }), undefined],
    [
      'both a guest id and guest details',
      () => ({ guestId: new Types.ObjectId().toHexString() }),
      undefined,
    ],
    [
      'an unknown guest id',
      () => ({ guest: undefined, guestId: new Types.ObjectId().toHexString() }),
      'unknown_guest',
    ],
    [
      'an unknown room type',
      () => ({ roomTypeId: new Types.ObjectId().toHexString() }),
      'unknown_room_type',
    ],
    ['a room of a different type', () => ({ roomId: roomIds['104'] }), 'unknown_room'],
    ['a bad phone number', () => ({ guest: { name: 'X Y', phone: 'abc' } }), undefined],
  ])('rejects %s', async (_label, overrides, code) => {
    const res = await book(overrides());
    expect(res.status).toBe(400);
    if (code) expect(res.body.error.code).toBe(code);
  });

  it('refuses a room, guest or room type that belongs to another property', async () => {
    const bDesk = await as(b, 'front_desk');
    const bRoom = (await bDesk.get('/api/v1/rooms?limit=1')).body.data[0].id;
    const bType = (await bDesk.get('/api/v1/room-types')).body.data[0].id;
    const bGuest = (await bDesk.post('/api/v1/guests', { name: 'B Guest', phone: nextPhone() }))
      .body.data.id;

    expect((await book({ roomId: bRoom })).status).toBe(400);
    expect((await book({ roomTypeId: bType })).status).toBe(400);
    expect((await book({ guest: undefined, guestId: bGuest })).body.error.code).toBe(
      'unknown_guest',
    );
  });

  it('writes an audit entry and tells the front desk and managers, nobody else', async () => {
    const events: DomainEvent[] = [];
    const off = eventBus.subscribe((event) => events.push(event));
    const res = await book();
    off();
    const created = events.filter((e) => e.type === 'booking.changed');
    expect(created).toHaveLength(1);
    expect(created[0]?.audience).toEqual({ departments: ['front_desk'] });
    expect(created[0]?.data).toMatchObject({
      bookingCode: res.body.data.bookingCode,
      change: 'created',
    });
    expect(String(created[0]?.propertyId)).toBe(a.id.toHexString());

    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'booking.created', 'target.id': res.body.data.id }).lean(),
    );
    expect(audits).toHaveLength(1);
  });
});

describe('double booking is impossible', () => {
  it('allows back-to-back stays in the same room (check-out day is the next check-in day)', async () => {
    const start = day(900);
    const first = await book({
      roomId: roomIds['201'],
      checkInDate: start,
      checkOutDate: addDays(start, 2),
    });
    const second = await book({
      roomId: roomIds['201'],
      checkInDate: addDays(start, 2),
      checkOutDate: addDays(start, 4),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it.each([
    ['the same dates', 0, 2],
    ['a stay that starts inside it', 1, 3],
    ['a stay that ends inside it', -1, 1],
    ['a stay that contains it', -1, 3],
    ['a one-night stay on its first night', 0, 1],
    ['a one-night stay on its last night', 1, 2],
  ])('refuses %s with 409 and leaves the first booking intact', async (_label, from, to) => {
    const start = day(1000 + windowCounter * 10);
    windowCounter++;
    const first = await book({
      roomTypeId: types.Deluxe,
      roomId: roomIds['202'],
      checkInDate: start,
      checkOutDate: addDays(start, 2),
    });
    expect(first.status).toBe(201);
    const clash = await book({
      roomTypeId: types.Deluxe,
      roomId: roomIds['202'],
      checkInDate: addDays(start, from),
      checkOutDate: addDays(start, to),
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('room_unavailable');
    const nights = await runWithTenant(a.id, () =>
      RoomNight.countDocuments({ bookingId: first.body.data.id }),
    );
    expect(nights).toBe(2);
  });

  it('gives exactly one winner when many requests want the same room and dates at once', async () => {
    const window = freshWindow(3);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        book({ ...window, roomId: roomIds['203'], roomTypeId: types.Deluxe }),
      ),
    );
    const wins = results.filter((r) => r.status === 201);
    const losses = results.filter((r) => r.status === 409);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(9);
    expect(losses.every((r) => r.body.error.code === 'room_unavailable')).toBe(true);

    // Exactly the winner's three nights exist, no half-written losers.
    const nights = await runWithTenant(a.id, () =>
      RoomNight.find({
        roomId: roomIds['203'],
        night: { $gte: window.checkInDate, $lt: window.checkOutDate },
      }).lean(),
    );
    expect(nights).toHaveLength(3);
    expect(new Set(nights.map((n) => String(n.bookingId)))).toEqual(
      new Set([wins[0]?.body.data.id]),
    );
    const bookingCount = await runWithTenant(a.id, () =>
      Booking.countDocuments({ roomId: roomIds['203'], checkInDate: window.checkInDate }),
    );
    expect(bookingCount).toBe(1);
  });

  it('gives each room of a type to exactly one request when more requests than rooms arrive', async () => {
    const window = freshWindow();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => book({ ...window, roomTypeId: types.Suite })),
    );
    // Only one Suite room (205) exists.
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 409)
        .every((r) => r.body.error.code === 'no_room_available'),
    ).toBe(true);

    const deluxe = freshWindow();
    const many = await Promise.all(
      Array.from({ length: 12 }, () => book({ ...deluxe, roomTypeId: types.Deluxe })),
    );
    const won = many.filter((r) => r.status === 201);
    // Deluxe has 104, 105, 202, 203, 204; five rooms, so at most five can succeed, each a different room.
    expect(won).toHaveLength(5);

    const roomsUsed = won.map((r) => r.body.data.roomNumber);
    expect(new Set(roomsUsed).size).toBe(roomsUsed.length);
    expect(many.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
  });
});

describe('cancelling and no-shows free the room', () => {
  it('lets the same room and nights be booked again after a cancellation', async () => {
    const window = freshWindow();
    const first = await book({ ...window, roomId: roomIds['103'] });
    expect((await book({ ...window, roomId: roomIds['103'] })).status).toBe(409);

    const cancelled = await desk.post(`/api/v1/bookings/${first.body.data.id}/cancel`, {
      reason: 'Guest changed plans',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Guest changed plans',
    });
    expect(cancelled.body.data.cancelledAt).not.toBeNull();

    expect(
      await runWithTenant(a.id, () => RoomNight.countDocuments({ bookingId: first.body.data.id })),
    ).toBe(0);
    expect((await book({ ...window, roomId: roomIds['103'] })).status).toBe(201);
  });

  it('needs a reason, and a booking can be cancelled only once', async () => {
    const created = await book();
    const id = created.body.data.id;
    expect((await desk.post(`/api/v1/bookings/${id}/cancel`, {})).status).toBe(400);
    expect((await desk.post(`/api/v1/bookings/${id}/cancel`, { reason: 'no' })).status).toBe(400);
    expect(
      (await desk.post(`/api/v1/bookings/${id}/cancel`, { reason: 'Changed plans' })).status,
    ).toBe(200);
    const again = await desk.post(`/api/v1/bookings/${id}/cancel`, { reason: 'Changed plans' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('bad_transition');
  });

  it('refuses any change to a cancelled booking', async () => {
    const created = await book();
    const id = created.body.data.id;
    await desk.post(`/api/v1/bookings/${id}/cancel`, { reason: 'Changed plans' });
    const res = await desk.patch(`/api/v1/bookings/${id}`, { notes: 'late note' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('booking_closed');
  });

  it('marks a no-show only once the arrival day has come, and then frees the nights', async () => {
    const future = await book();
    const early = await desk.post(`/api/v1/bookings/${future.body.data.id}/no-show`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('too_early');

    const arrivingToday = await book({
      roomId: roomIds['105'],
      roomTypeId: types.Deluxe,
      checkInDate: today(),
      checkOutDate: day(1),
    });
    const res = await desk.post(`/api/v1/bookings/${arrivingToday.body.data.id}/no-show`);
    expect(res.body.data.status).toBe('no_show');
    expect(
      await runWithTenant(a.id, () =>
        RoomNight.countDocuments({ bookingId: arrivingToday.body.data.id }),
      ),
    ).toBe(0);
  });
});

describe('changing a booking', () => {
  it('extends a stay and takes the extra nights', async () => {
    const window = freshWindow(2);
    const created = await book({ ...window, roomId: roomIds['101'] });
    const res = await desk.patch(`/api/v1/bookings/${created.body.data.id}`, {
      checkOutDate: addDays(window.checkOutDate, 2),
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ nights: 4, roomTotalPaise: 1_000_000 });
    expect(
      await runWithTenant(a.id, () =>
        RoomNight.countDocuments({ bookingId: created.body.data.id }),
      ),
    ).toBe(4);
  });

  it('shortens a stay and frees the dropped nights', async () => {
    const window = freshWindow(3);
    const created = await book({ ...window, roomId: roomIds['102'] });
    await desk.patch(`/api/v1/bookings/${created.body.data.id}`, {
      checkOutDate: addDays(window.checkInDate, 1),
    });
    expect(
      await runWithTenant(a.id, () =>
        RoomNight.countDocuments({ bookingId: created.body.data.id }),
      ),
    ).toBe(1);
    const reuse = await book({
      roomId: roomIds['102'],
      checkInDate: addDays(window.checkInDate, 1),
      checkOutDate: window.checkOutDate,
    });
    expect(reuse.status).toBe(201);
  });

  it('refuses an extension into another booking, and leaves everything exactly as it was', async () => {
    const start = day(1500 + windowCounter);
    const first = await book({
      roomId: roomIds['104'],
      roomTypeId: types.Deluxe,
      checkInDate: start,
      checkOutDate: addDays(start, 2),
    });
    await book({
      roomId: roomIds['104'],
      roomTypeId: types.Deluxe,
      checkInDate: addDays(start, 3),
      checkOutDate: addDays(start, 5),
    });
    const res = await desk.patch(`/api/v1/bookings/${first.body.data.id}`, {
      checkOutDate: addDays(start, 4),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('room_unavailable');

    const unchanged = await desk.get(`/api/v1/bookings/${first.body.data.id}`);
    expect(unchanged.body.data).toMatchObject({
      checkInDate: start,
      checkOutDate: addDays(start, 2),
      nights: 2,
    });
    const nights = await runWithTenant(a.id, () =>
      RoomNight.find({ bookingId: first.body.data.id }).lean(),
    );
    expect(nights).toHaveLength(2);
  });

  it('moves a booking to another free room, and refuses a taken one', async () => {
    const window = freshWindow();
    const created = await book({ ...window, roomId: roomIds['101'] });
    await book({ ...window, roomId: roomIds['102'] });
    const taken = await desk.patch(`/api/v1/bookings/${created.body.data.id}`, {
      roomId: roomIds['102'],
    });
    expect(taken.status).toBe(409);
    const moved = await desk.patch(`/api/v1/bookings/${created.body.data.id}`, {
      roomId: roomIds['103'],
    });
    expect(moved.body.data.roomNumber).toBe('103');
    const held = await runWithTenant(a.id, () =>
      RoomNight.find({ bookingId: created.body.data.id }).lean(),
    );
    expect(held.every((n) => String(n.roomId) === roomIds['103'])).toBe(true);
    expect(held).toHaveLength(2);
  });

  it('re-prices when the booking moves to a room of another type', async () => {
    const created = await book({ roomId: roomIds['101'] });
    const moved = await desk.patch(`/api/v1/bookings/${created.body.data.id}`, {
      roomId: roomIds['205'],
    });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ roomTypeName: 'Suite', nightlyRatePaise: 900_000 });
  });

  it('keeps the original rate when only the dates change', async () => {
    const created = await book();
    const { Types: T } = await import('mongoose');
    void T;
    const typeId = created.body.data.roomTypeId;
    await manager.patch(`/api/v1/room-types/${typeId}`, { ratePaise: 999_900 });
    const res = await desk.patch(`/api/v1/bookings/${created.body.data.id}`, {
      notes: 'late arrival',
    });
    expect(res.body.data.nightlyRatePaise).toBe(250_000);
    await manager.patch(`/api/v1/room-types/${typeId}`, { ratePaise: 250_000 });
  });

  it('refuses capacity, past-date and bad-date changes', async () => {
    const created = await book();
    const id = created.body.data.id;
    expect((await desk.patch(`/api/v1/bookings/${id}`, { adults: 3 })).body.error.code).toBe(
      'over_capacity',
    );
    expect(
      (await desk.patch(`/api/v1/bookings/${id}`, { checkInDate: day(-3), checkOutDate: day(-1) }))
        .body.error.code,
    ).toBe('date_in_past');
    expect((await desk.patch(`/api/v1/bookings/${id}`, { checkOutDate: day(-3) })).status).toBe(
      400,
    );
    expect((await desk.patch(`/api/v1/bookings/${id}`, {})).status).toBe(400);
  });

  it('cannot be changed by two people at once into the same dates', async () => {
    const start = day(2000 + windowCounter);
    const one = await book({
      roomId: roomIds['201'],
      checkInDate: start,
      checkOutDate: addDays(start, 1),
    });
    const two = await book({
      roomId: roomIds['201'],
      checkInDate: addDays(start, 5),
      checkOutDate: addDays(start, 6),
    });
    const [r1, r2] = await Promise.all([
      desk.patch(`/api/v1/bookings/${one.body.data.id}`, { checkOutDate: addDays(start, 8) }),
      desk.patch(`/api/v1/bookings/${two.body.data.id}`, {
        checkInDate: addDays(start, 3),
        checkOutDate: addDays(start, 9),
      }),
    ]);
    expect([r1.status, r2.status].filter((s) => s === 200)).toHaveLength(1);
  });
});

describe('booking lifecycle: confirm, check-in', () => {
  const arriving = (roomNumber: string, type = types.Standard) => ({
    roomTypeId: type,
    roomId: roomIds[roomNumber],
    checkInDate: today(),
    checkOutDate: day(2),
  });

  it('confirms a pending booking, once', async () => {
    const pending = await book({ status: 'pending' });
    const id = pending.body.data.id;
    expect((await desk.post(`/api/v1/bookings/${id}/confirm`)).body.data.status).toBe('confirmed');
    expect((await desk.post(`/api/v1/bookings/${id}/confirm`)).status).toBe(409);
  });

  it('checks a guest in: booking checked-in with a time, room occupied, history recorded', async () => {
    const created = await book(arriving('104', types.Deluxe));
    // 104 may be used by other tests today only if they overlap today; this one owns today.
    const id = created.body.data.id;
    const res = await desk.post(`/api/v1/bookings/${id}/check-in`, { note: 'ID seen' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('checked_in');
    expect(res.body.data.checkedInAt).not.toBeNull();

    const room = await runWithTenant(a.id, () => Room.findOne({ _id: roomIds['104'] }).lean());
    expect(room?.status).toBe('occupied');
    expect(room?.history.at(-1)).toMatchObject({ from: 'available', to: 'occupied' });
    const booking = await runWithTenant(a.id, () => Booking.findOne({ _id: id }).lean());
    expect(booking?.history.map((h) => h.to)).toEqual(['confirmed', 'checked_in']);
    expect(booking?.history[1]?.note).toBe('ID seen');
  });

  it('sends the front desk the booking and the room-status events after check-in', async () => {
    const created = await book(arriving('204', types.Deluxe));
    const events: DomainEvent[] = [];
    const off = eventBus.subscribe((event) => events.push(event));
    await desk.post(`/api/v1/bookings/${created.body.data.id}/check-in`, {});
    off();
    expect(events.map((e) => e.type).sort()).toEqual(['booking.changed', 'room.status_changed']);
    const room = events.find((e) => e.type === 'room.status_changed');
    expect(room?.data).toMatchObject({
      roomNumber: '204',
      status: 'occupied',
      previous: 'available',
    });
  });

  it('will not check in a pending booking, or one arriving in the future', async () => {
    const pending = await book({ ...arriving('201'), status: 'pending' });
    const refusedPending = await desk.post(`/api/v1/bookings/${pending.body.data.id}/check-in`, {});
    expect(refusedPending.status).toBe(409);
    expect(refusedPending.body.error.code).toBe('bad_transition');

    const future = await book();
    const refusedFuture = await desk.post(`/api/v1/bookings/${future.body.data.id}/check-in`, {});
    expect(refusedFuture.status).toBe(409);
    expect(refusedFuture.body.error.code).toBe('not_arrival_day');
  });

  it('will not check in twice or cancel a guest who is in the house', async () => {
    const created = await book(arriving('202', types.Deluxe));
    const id = created.body.data.id;
    expect((await desk.post(`/api/v1/bookings/${id}/check-in`, {})).status).toBe(200);
    expect((await desk.post(`/api/v1/bookings/${id}/check-in`, {})).status).toBe(409);
    expect(
      (await desk.post(`/api/v1/bookings/${id}/cancel`, { reason: 'Changed my mind' })).status,
    ).toBe(409);
    expect((await desk.post(`/api/v1/bookings/${id}/no-show`)).status).toBe(409);
    expect((await desk.post(`/api/v1/bookings/${id}/confirm`)).status).toBe(409);
  });

  it('will not put a guest in a room that is not ready (cleaning or out of service)', async () => {
    const created = await book(arriving('203', types.Deluxe));
    await runWithTenant(a.id, () =>
      Room.updateOne({ _id: roomIds['203'] }, { status: 'cleaning' }),
    );
    const res = await desk.post(`/api/v1/bookings/${created.body.data.id}/check-in`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('room_not_ready');
    expect((await desk.get(`/api/v1/bookings/${created.body.data.id}`)).body.data.status).toBe(
      'confirmed',
    );

    await runWithTenant(a.id, () =>
      Room.updateOne({ _id: roomIds['203'] }, { status: 'available' }),
    );
    expect((await desk.post(`/api/v1/bookings/${created.body.data.id}/check-in`, {})).status).toBe(
      200,
    );
  });

  it('can check the guest into a different free room, moving the held nights', async () => {
    const created = await book(arriving('101'));
    const res = await desk.post(`/api/v1/bookings/${created.body.data.id}/check-in`, {
      roomId: roomIds['102'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.roomNumber).toBe('102');
    const held = await runWithTenant(a.id, () =>
      RoomNight.find({ bookingId: created.body.data.id }).lean(),
    );
    expect(held.every((n) => String(n.roomId) === roomIds['102'])).toBe(true);
    const room102 = await runWithTenant(a.id, () => Room.findOne({ _id: roomIds['102'] }).lean());
    expect(room102?.status).toBe('occupied');
    const room101 = await runWithTenant(a.id, () => Room.findOne({ _id: roomIds['101'] }).lean());
    expect(room101?.status).toBe('available');
  });

  it('refuses a check-in room that another booking holds that night, and changes nothing', async () => {
    const mine = await book(arriving('103'));
    await book({ ...arriving('205', types.Suite) });
    const res = await desk.post(`/api/v1/bookings/${mine.body.data.id}/check-in`, {
      roomId: roomIds['205'],
    });
    expect(res.status).toBe(409);
    const booking = await desk.get(`/api/v1/bookings/${mine.body.data.id}`);
    expect(booking.body.data).toMatchObject({ status: 'confirmed', roomNumber: '103' });
    const room205 = await runWithTenant(a.id, () => Room.findOne({ _id: roomIds['205'] }).lean());
    expect(room205?.status).toBe('available');
  });

  it('lets only one of two simultaneous check-ins into the same room win', async () => {
    const { Room: R } = await import('../rooms/room.model');
    void R;
    const one = await book({ ...arriving('105', types.Deluxe), checkOutDate: day(1) });
    const results = await Promise.all([
      desk.post(`/api/v1/bookings/${one.body.data.id}/check-in`, {}),
      desk.post(`/api/v1/bookings/${one.body.data.id}/check-in`, {}),
      desk.post(`/api/v1/bookings/${one.body.data.id}/check-in`, {}),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });
});

describe('availability', () => {
  it('lists free rooms by type and drops booked ones', async () => {
    const window = freshWindow();
    await book({ ...window, roomId: roomIds['101'] });
    const res = await desk.get(
      `/api/v1/bookings/availability?checkInDate=${window.checkInDate}&checkOutDate=${window.checkOutDate}`,
    );
    expect(res.status).toBe(200);
    const standard = res.body.data.roomTypes.find(
      (type: { roomTypeName: string }) => type.roomTypeName === 'Standard',
    );
    expect(standard.totalRooms).toBe(4);
    expect(standard.nightlyRatePaise).toBe(250_000);
    expect(standard.availableRooms.map((room: { number: string }) => room.number)).toEqual([
      '102',
      '103',
      '201',
    ]);
    expect(res.body.data.nights).toBe(2);
  });

  it('shows the room as free again on the day the previous guest leaves', async () => {
    const window = freshWindow(2);
    await book({ ...window, roomId: roomIds['101'] });
    const res = await desk.get(
      `/api/v1/bookings/availability?checkInDate=${window.checkOutDate}&checkOutDate=${addDays(window.checkOutDate, 1)}&roomTypeId=${types.Standard}`,
    );
    expect(
      res.body.data.roomTypes[0].availableRooms.map((r: { number: string }) => r.number),
    ).toContain('101');
  });

  it('keeps an out-of-service room out of tonight’s stays but not out of future dates', async () => {
    await runWithTenant(a.id, () =>
      Room.updateOne({ _id: roomIds['205'] }, { status: 'out_of_service' }),
    );
    try {
      const tonight = await desk.get(
        `/api/v1/bookings/availability?checkInDate=${today()}&checkOutDate=${day(1)}&roomTypeId=${types.Suite}`,
      );
      expect(tonight.body.data.roomTypes[0].availableRooms).toHaveLength(0);
      const later = await desk.get(
        `/api/v1/bookings/availability?checkInDate=${day(30)}&checkOutDate=${day(31)}&roomTypeId=${types.Suite}`,
      );
      expect(later.body.data.roomTypes[0].availableRooms).toHaveLength(1);
      expect(
        (
          await book({
            roomTypeId: types.Suite,
            roomId: roomIds['205'],
            checkInDate: today(),
            checkOutDate: day(1),
          })
        ).body.error.code,
      ).toBe('room_out_of_service');
    } finally {
      await runWithTenant(a.id, () =>
        Room.updateOne({ _id: roomIds['205'] }, { status: 'available' }),
      );
    }
  });

  it('validates the dates', async () => {
    expect(
      (
        await desk.get(
          '/api/v1/bookings/availability?checkInDate=2026-01-02&checkOutDate=2026-01-01',
        )
      ).status,
    ).toBe(400);
    expect((await desk.get('/api/v1/bookings/availability')).status).toBe(400);
  });
});

describe('timezone handling', () => {
  async function setTimezone(timezone: string): Promise<void> {
    await runAsPlatform(() => Property.updateOne({ _id: a.id }, { timezone }));
  }

  it('decides "today" in the property’s timezone, not the server’s', async () => {
    const ahead = 'Pacific/Kiritimati';
    const behind = 'Pacific/Pago_Pago';
    try {
      // For a property that is 25 hours ahead, the date it is still "today" at the dateline is past.
      await setTimezone(ahead);
      const pastThere = await book({
        checkInDate: todayIn(behind),
        checkOutDate: addDays(todayIn(behind), 2),
      });
      expect(pastThere.status).toBe(400);
      expect(pastThere.body.error.code).toBe('date_in_past');

      // A property far behind can still book the date that is "today" far ahead.
      await setTimezone(behind);
      const start = todayIn(ahead);
      const fine = await book({
        checkInDate: start,
        checkOutDate: addDays(start, 1),
        roomId: roomIds['101'],
      });
      expect(fine.status).toBe(201);
      const overview = await desk.get('/api/v1/bookings/overview');
      expect(overview.body.data.date).toBe(todayIn(behind));
    } finally {
      await setTimezone(TZ);
    }
  });
});

describe('front desk overview, calendar and search', () => {
  it('lists today’s arrivals, departures and in-house guests with room status counts', async () => {
    const overview = await desk.get('/api/v1/bookings/overview');
    expect(overview.status).toBe(200);
    const data = overview.body.data;
    expect(data.date).toBe(today());
    expect(data.counts.totalRooms).toBe(10);
    const statuses = Object.values(data.counts.roomsByStatus) as number[];
    expect(statuses.reduce((x, y) => x + y, 0)).toBe(10);
    expect(data.counts.inHouse).toBe(data.inHouse.length);
    for (const arrival of data.arrivals) expect(arrival.checkInDate).toBe(today());
    for (const guest of data.inHouse) expect(guest.status).toBe('checked_in');
    expect(data.counts.arrivalsCheckedIn).toBe(
      data.arrivals.filter((x: { status: string }) => x.status === 'checked_in').length,
    );
  });

  it('shows a calendar window of holding bookings only, limited to 62 days', async () => {
    const window = freshWindow();
    const live = await book({ ...window, roomId: roomIds['101'] });
    const dead = await book({ ...window, roomId: roomIds['102'] });
    await desk.post(`/api/v1/bookings/${dead.body.data.id}/cancel`, { reason: 'Not coming' });
    const res = await desk.get(
      `/api/v1/bookings/calendar?from=${window.checkInDate}&to=${window.checkOutDate}`,
    );
    const ids = res.body.data.map((x: { id: string }) => x.id);
    expect(ids).toContain(live.body.data.id);
    expect(ids).not.toContain(dead.body.data.id);
    expect(
      (await desk.get(`/api/v1/bookings/calendar?from=${today()}&to=${day(100)}`)).status,
    ).toBe(400);
  });

  it('searches by booking code, guest name and phone, and filters by status and window', async () => {
    const phone = nextPhone();
    const window = freshWindow();
    const created = await book({ ...window, guest: { name: 'Zainab Findable', phone } });
    const code = created.body.data.bookingCode as string;

    for (const q of [code, code.toLowerCase(), 'zainab find', phone.slice(3), phone]) {
      const res = await desk.get(`/api/v1/bookings?q=${encodeURIComponent(q)}`);
      expect(
        res.body.data.map((x: { id: string }) => x.id),
        q,
      ).toContain(created.body.data.id);
    }
    const inWindow = await desk.get(
      `/api/v1/bookings?from=${window.checkInDate}&to=${window.checkInDate}&status=confirmed&limit=100`,
    );
    expect(inWindow.body.data.map((x: { id: string }) => x.id)).toContain(created.body.data.id);
    const cancelledOnly = await desk.get(`/api/v1/bookings?q=${code}&status=cancelled`);
    expect(cancelledOnly.body.data).toHaveLength(0);
  });

  it('pages and caps list sizes, and treats regex characters as text', async () => {
    const page = await desk.get('/api/v1/bookings?limit=2&page=1');
    expect(page.body.data.length).toBeLessThanOrEqual(2);
    expect(page.body.meta).toMatchObject({ page: 1, limit: 2 });
    expect((await desk.get('/api/v1/bookings?limit=1000')).status).toBe(400);
    expect((await desk.get('/api/v1/bookings?q=.*')).body.data).toHaveLength(0);
  });
});

describe('access and tenant isolation', () => {
  const allowed: StaffRole[] = ['platform_admin', 'property_admin', 'manager', 'front_desk'];

  for (const role of STAFF_ROLES) {
    it(`${role} is ${allowed.includes(role) ? 'allowed' : 'refused (403)'} on the booking routes`, async () => {
      const client = await as(a, role);
      const expected = allowed.includes(role);
      expect((await client.get('/api/v1/bookings')).status).toBe(expected ? 200 : 403);
      expect((await client.get('/api/v1/bookings/overview')).status).toBe(expected ? 200 : 403);
      expect((await client.post('/api/v1/bookings', {})).status).toBe(expected ? 400 : 403);
      const someId = new Types.ObjectId().toHexString();
      expect((await client.post(`/api/v1/bookings/${someId}/check-in`, {})).status).toBe(
        expected ? 404 : 403,
      );
      expect(
        (await client.post(`/api/v1/bookings/${someId}/cancel`, { reason: 'because' })).status,
      ).toBe(expected ? 404 : 403);
    });
  }

  it('answers 401 without a sign-in', async () => {
    expect((await t.anonymous.get('/api/v1/bookings')).status).toBe(401);
    expect((await t.anonymous.post('/api/v1/bookings', {})).status).toBe(401);
  });

  it('keeps properties apart: another property cannot see, change, cancel or check in a booking', async () => {
    const created = await book();
    const id = created.body.data.id;
    const bDesk = await as(b, 'front_desk');
    expect((await bDesk.get(`/api/v1/bookings/${id}`)).status).toBe(404);
    expect((await bDesk.patch(`/api/v1/bookings/${id}`, { notes: 'x' })).status).toBe(404);
    expect((await bDesk.post(`/api/v1/bookings/${id}/cancel`, { reason: 'because' })).status).toBe(
      404,
    );
    expect((await bDesk.post(`/api/v1/bookings/${id}/check-in`, {})).status).toBe(404);
    expect((await bDesk.post(`/api/v1/bookings/${id}/confirm`)).status).toBe(404);
    const list = await bDesk.get('/api/v1/bookings?limit=100');
    expect(list.body.data.map((x: { id: string }) => x.id)).not.toContain(id);
    const theirs = await book({ roomId: undefined }, bDesk);
    expect(theirs.status).toBe(400); // property B has no such room type id
  });

  it('lets both properties hold the same room number and dates independently', async () => {
    const bDesk = await as(b, 'front_desk');
    const bTypes = (await bDesk.get('/api/v1/room-types')).body.data as {
      id: string;
      name: string;
    }[];
    const bStandard = bTypes.find((x) => x.name === 'Standard')?.id;
    const window = freshWindow();
    const mine = await book({ ...window, roomId: roomIds['101'] });
    const theirs = await bDesk.post('/api/v1/bookings', {
      guest: { name: 'B Guest', phone: nextPhone() },
      roomTypeId: bStandard,
      ...window,
      adults: 1,
    });
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.body.data.roomNumber).toBe('101');
  });
});
