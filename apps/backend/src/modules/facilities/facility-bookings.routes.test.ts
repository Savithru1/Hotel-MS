import type { StaffRole } from '@hospitality/constants';
import type {
  FacilityBookingDto,
  FacilityBookingSummaryDto,
  FacilityDto,
  FacilitySlotDto,
} from '@hospitality/shared-types';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { addStaff, checkInGuest, day, lookup, type Lookup } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { eventBus, type DomainEvent } from '../../shared/events/event-bus';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { FacilityBooking } from './facility-booking.model';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
let ids: Lookup;
let guestBooking: string;
const t = buildTestApp();

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

let manager: Client;
let desk: Client;
let spa: Client;
let otherManager: Client;
let otherDesk: Client;

let spaRoom: FacilityDto; // one person at a time
let pool: FacilityDto; // three people per slot
let gym: FacilityDto; // open all day
let studio: FacilityDto; // takes 100 people, so workflow tests never fight over a slot

const FACILITIES = '/api/v1/facilities';
const BOOKINGS = '/api/v1/facility-bookings';

async function addFacility(client: Client, body: Record<string, unknown>): Promise<FacilityDto> {
  const res = await client.post(FACILITIES, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as FacilityDto;
}

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await as(a, 'manager');
  desk = await as(a, 'front_desk');
  spa = await as(a, 'spa_recreation');
  otherManager = await as(b, 'manager');
  otherDesk = await as(b, 'front_desk');
  ids = await lookup(desk);
  guestBooking = (await checkInGuest(desk, ids, '101', 'Standard', '+917000000911')).bookingId;
  await checkInGuest(desk, ids, '102', 'Standard', '+917000000912');

  spaRoom = await addFacility(manager, {
    name: 'Ayurvedic Spa',
    type: 'spa',
    capacity: 1,
    slotMinutes: 60,
    opensAt: '09:00',
    closesAt: '18:00',
    pricePaise: 150_000,
  });
  pool = await addFacility(manager, {
    name: 'Rooftop Pool',
    type: 'pool',
    capacity: 3,
    slotMinutes: 30,
    opensAt: '08:00',
    closesAt: '20:00',
    pricePaise: 20_000,
  });
  gym = await addFacility(manager, {
    name: 'All Day Gym',
    type: 'gym',
    capacity: 5,
    slotMinutes: 60,
    opensAt: '00:00',
    closesAt: '23:59',
    pricePaise: 0,
  });
  studio = await addFacility(manager, {
    name: 'Yoga Studio',
    type: 'activity',
    capacity: 100,
    slotMinutes: 60,
    opensAt: '09:00',
    closesAt: '18:00',
    pricePaise: 150_000,
  });
});

const slotOf = async (facility: FacilityDto, date: string, startTime: string) =>
  (
    (await spa.get(`${FACILITIES}/${facility.id}/slots?date=${date}`)).body
      .data as FacilitySlotDto[]
  ).find((s) => s.startTime === startTime);

async function book(
  extra: Record<string, unknown> = {},
  client: Client = desk,
  facility: FacilityDto = studio,
): Promise<FacilityBookingDto> {
  const res = await client.post(BOOKINGS, {
    facilityId: facility.id,
    roomId: ids.rooms['101'],
    date: day(1),
    startTime: '10:00',
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as FacilityBookingDto;
}

function capture(): { events: DomainEvent[]; stop: () => void } {
  const events: DomainEvent[] = [];
  const stop = eventBus.subscribe((event) => events.push(event));
  return { events, stop };
}

describe('booking a facility', () => {
  it('prices from the facility, snapshots the guest and starts as Requested', async () => {
    const created = await book({ startTime: '12:00', participants: 2 }, desk, pool);
    expect(created).toMatchObject({
      status: 'requested',
      facilityId: pool.id,
      facilityName: 'Rooftop Pool',
      facilityType: 'pool',
      roomNumber: '101',
      bookingId: guestBooking,
      guestName: 'In House Guest',
      date: day(1),
      startTime: '12:00',
      endTime: '12:30',
      participants: 2,
      unitPricePaise: 20_000,
      totalPaise: 40_000,
      notes: '',
      source: 'front_desk',
      cancelReason: null,
    });
    expect(created.code).toMatch(/^FB-[A-HJKMNP-Z2-9]{6}$/);
  });

  it('records who made it: spa staff, the front desk, or a manager', async () => {
    expect((await book({}, spa)).source).toBe('spa_recreation');
    expect((await book({}, desk)).source).toBe('front_desk');
    expect((await book({}, manager)).source).toBe('front_desk');
  });

  it('ignores any price, status, booking or property sent by the client', async () => {
    const created = await book({
      startTime: '14:00',
      unitPricePaise: 1,
      totalPaise: 1,
      pricePaise: 1,
      status: 'completed',
      source: 'guest',
      bookingId: new Types.ObjectId().toHexString(),
      propertyId: b.id.toHexString(),
    });
    expect(created).toMatchObject({
      status: 'requested',
      unitPricePaise: 150_000,
      totalPaise: 150_000,
      source: 'front_desk',
      bookingId: guestBooking,
    });
    expect(
      await runWithTenant(b.id, () => FacilityBooking.countDocuments({ _id: created.id })),
    ).toBe(0);
  });

  it('is free to book a free facility', async () => {
    const created = await book({ startTime: '11:00', participants: 3 }, desk, gym);
    expect(created).toMatchObject({ unitPricePaise: 0, totalPaise: 0 });
  });

  it('keeps a price already given when the facility price changes later', async () => {
    const created = await book({ startTime: '15:00', participants: 2 }, desk, pool);
    await manager.patch(`${FACILITIES}/${pool.id}`, { pricePaise: 99_000 });
    const stored = (await spa.get(`${BOOKINGS}/${created.id}`)).body.data as FacilityBookingDto;
    expect(stored).toMatchObject({ unitPricePaise: 20_000, totalPaise: 40_000 });
    await manager.patch(`${FACILITIES}/${pool.id}`, { pricePaise: 20_000 });
  });

  it('refuses a room with no guest, an unknown room and another property’s room', async () => {
    const empty = await desk.post(BOOKINGS, {
      facilityId: spaRoom.id,
      roomId: ids.rooms['103'],
      date: day(1),
      startTime: '09:00',
    });
    expect(empty.status).toBe(409);
    expect(empty.body.error.code).toBe('no_guest_in_room');
    const otherRoom = (await otherDesk.get('/api/v1/rooms?limit=1')).body.data[0].id;
    for (const roomId of [new Types.ObjectId().toHexString(), otherRoom]) {
      const res = await desk.post(BOOKINGS, {
        facilityId: spaRoom.id,
        roomId,
        date: day(1),
        startTime: '09:00',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('unknown_room');
    }
  });

  it('refuses an unknown facility, another property’s facility and an inactive one', async () => {
    const theirs = await addFacility(otherManager, {
      name: 'Other Spa',
      type: 'spa',
      capacity: 1,
      slotMinutes: 60,
      opensAt: '09:00',
      closesAt: '18:00',
      pricePaise: 100,
    });
    for (const facilityId of [new Types.ObjectId().toHexString(), theirs.id]) {
      const res = await desk.post(BOOKINGS, {
        facilityId,
        roomId: ids.rooms['101'],
        date: day(1),
        startTime: '09:00',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('unknown_facility');
    }
    const closed = await addFacility(manager, {
      name: 'Closed Sauna',
      type: 'spa',
      capacity: 1,
      slotMinutes: 60,
      opensAt: '09:00',
      closesAt: '18:00',
      pricePaise: 100,
      active: false,
    });
    const res = await desk.post(BOOKINGS, {
      facilityId: closed.id,
      roomId: ids.rooms['101'],
      date: day(1),
      startTime: '09:00',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('facility_inactive');
  });

  it('refuses a start time that is not the start of a slot', async () => {
    for (const startTime of ['09:30', '08:00', '18:00', '23:00']) {
      const res = await desk.post(BOOKINGS, {
        facilityId: spaRoom.id,
        roomId: ids.rooms['101'],
        date: day(1),
        startTime,
      });
      expect(res.status, startTime).toBe(400);
      expect(res.body.error.code).toBe('invalid_slot');
    }
  });

  it('refuses a slot that has already started, and a past date', async () => {
    const started = await desk.post(BOOKINGS, {
      facilityId: gym.id,
      roomId: ids.rooms['101'],
      date: day(0),
      startTime: '00:00',
    });
    expect(started.status).toBe(409);
    expect(started.body.error.code).toBe('slot_in_past');
    const yesterday = await desk.post(BOOKINGS, {
      facilityId: gym.id,
      roomId: ids.rooms['101'],
      date: day(-1),
      startTime: '10:00',
    });
    expect(yesterday.status).toBe(409);
    expect(yesterday.body.error.code).toBe('slot_in_past');
  });

  it('refuses a date outside the guest’s stay', async () => {
    const res = await desk.post(BOOKINGS, {
      facilityId: gym.id,
      roomId: ids.rooms['101'],
      date: day(5),
      startTime: '10:00',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('outside_stay');
  });

  it('refuses more people than the facility takes, with a clear message', async () => {
    const res = await desk.post(BOOKINGS, {
      facilityId: pool.id,
      roomId: ids.rooms['101'],
      date: day(1),
      startTime: '16:00',
      participants: 4,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('too_many_participants');
  });

  it('rejects malformed requests with a 400', async () => {
    for (const bad of [
      {},
      { facilityId: spaRoom.id, roomId: ids.rooms['101'], date: 'tomorrow', startTime: '09:00' },
      { facilityId: spaRoom.id, roomId: ids.rooms['101'], date: day(1), startTime: '9am' },
      {
        facilityId: spaRoom.id,
        roomId: ids.rooms['101'],
        date: day(1),
        startTime: '09:00',
        participants: 0,
      },
    ]) {
      const res = await desk.post(BOOKINGS, bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
  });

  it('announces it to spa, the front desk and managers without guest details, and audits it', async () => {
    const { events, stop } = capture();
    const created = await book({ startTime: '17:00', notes: 'Allergic to nuts' });
    stop();
    const changed = events.filter((e) => e.type === 'facility_booking.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.audience).toEqual({ departments: ['spa_recreation', 'front_desk'] });
    expect(changed[0]?.data).toEqual({
      facilityBookingId: created.id,
      code: created.code,
      facilityId: studio.id,
      facilityName: 'Yoga Studio',
      roomId: ids.rooms['101'],
      roomNumber: '101',
      date: day(1),
      startTime: '17:00',
      status: 'requested',
      change: 'created',
    });
    expect(JSON.stringify(changed[0]?.data)).not.toMatch(/In House Guest|nuts/);
    expect(events.filter((e) => e.type === 'facility_booking.completed')).toHaveLength(0);
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'facility_booking.created', 'target.id': created.id }).lean(),
    );
    expect(audits).toHaveLength(1);
  });
});

describe('double booking and capacity', () => {
  it('lets only one booking have an exclusive slot, and another slot stays free', async () => {
    const date = day(2);
    const first = await desk.post(BOOKINGS, {
      facilityId: spaRoom.id,
      roomId: ids.rooms['101'],
      date,
      startTime: '09:00',
    });
    expect(first.status).toBe(201);
    const second = await desk.post(BOOKINGS, {
      facilityId: spaRoom.id,
      roomId: ids.rooms['102'],
      date,
      startTime: '09:00',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('slot_full');
    const other = await desk.post(BOOKINGS, {
      facilityId: spaRoom.id,
      roomId: ids.rooms['102'],
      date,
      startTime: '10:00',
    });
    expect(other.status).toBe(201);
  });

  it('shares a slot up to its capacity and refuses a request that would not fit', async () => {
    const date = day(2);
    const slot = (participants: number, room = '101') =>
      desk.post(BOOKINGS, {
        facilityId: pool.id,
        roomId: ids.rooms[room],
        date,
        startTime: '09:00',
        participants,
      });
    expect((await slot(2)).status).toBe(201);
    const tooMany = await slot(2, '102');
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('slot_full');
    expect((await slot(1, '102')).status).toBe(201);
    expect((await slot(1)).status).toBe(409);
    expect(await slotOf(pool, date, '09:00')).toMatchObject({
      booked: 3,
      remaining: 0,
      bookable: false,
    });
  });

  it('lets exactly one of several simultaneous requests take the last place', async () => {
    const date = day(2);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        desk.post(BOOKINGS, {
          facilityId: spaRoom.id,
          roomId: ids.rooms['101'],
          date,
          startTime: '15:00',
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    for (const res of results.filter((r) => r.status === 409)) {
      expect(res.body.error.code).toBe('slot_full');
    }
    expect(await slotOf(spaRoom, date, '15:00')).toMatchObject({ booked: 1, bookable: false });
    const stored = await runWithTenant(a.id, () =>
      FacilityBooking.countDocuments({ facilityId: spaRoom.id, date, startTime: '15:00' }),
    );
    expect(stored).toBe(1);
  });

  it('never goes over capacity when many people book a shared slot at once', async () => {
    const date = day(2);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        desk.post(BOOKINGS, {
          facilityId: pool.id,
          roomId: ids.rooms['102'],
          date,
          startTime: '18:00',
          participants: 1,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await slotOf(pool, date, '18:00')).toMatchObject({ booked: 3, remaining: 0 });
  });

  it('frees the place when a booking is cancelled, so someone else can take it', async () => {
    const date = day(2);
    const first = await desk.post(BOOKINGS, {
      facilityId: spaRoom.id,
      roomId: ids.rooms['101'],
      date,
      startTime: '16:00',
    });
    expect(first.status).toBe(201);
    expect(
      (
        await desk.post(BOOKINGS, {
          facilityId: spaRoom.id,
          roomId: ids.rooms['102'],
          date,
          startTime: '16:00',
        })
      ).status,
    ).toBe(409);
    expect(
      (await desk.post(`${BOOKINGS}/${first.body.data.id}/cancel`, { reason: 'Changed plans' }))
        .status,
    ).toBe(200);
    const retaken = await desk.post(BOOKINGS, {
      facilityId: spaRoom.id,
      roomId: ids.rooms['102'],
      date,
      startTime: '16:00',
    });
    expect(retaken.status).toBe(201);
  });

  it('does not free the place twice if the same booking is cancelled twice at once', async () => {
    const date = day(2);
    const first = await desk.post(BOOKINGS, {
      facilityId: pool.id,
      roomId: ids.rooms['101'],
      date,
      startTime: '19:00',
      participants: 2,
    });
    const id = first.body.data.id as string;
    const results = await Promise.all([
      desk.post(`${BOOKINGS}/${id}/cancel`, { reason: 'Changed plans' }),
      spa.post(`${BOOKINGS}/${id}/cancel`, { reason: 'Changed plans' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await slotOf(pool, date, '19:00')).toMatchObject({ booked: 0, remaining: 3 });
  });
});

describe('the booking workflow: Requested -> Confirmed -> Active -> Completed', () => {
  it('moves one step at a time and keeps the history and timestamps', async () => {
    const created = await book();
    const confirmed = await spa.post(`${BOOKINGS}/${created.id}/confirm`);
    expect(confirmed.body.data).toMatchObject({ status: 'confirmed' });
    expect(confirmed.body.data.confirmedAt).toBeTruthy();
    const started = await spa.post(`${BOOKINGS}/${created.id}/start`);
    expect(started.body.data).toMatchObject({ status: 'active' });
    expect(started.body.data.startedAt).toBeTruthy();
    const done = await spa.post(`${BOOKINGS}/${created.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'completed' });
    expect(done.body.data.completedAt).toBeTruthy();
    const stored = await runWithTenant(a.id, () =>
      FacilityBooking.findOne({ _id: created.id }).lean(),
    );
    expect(stored?.history.map((h) => h.to)).toEqual([
      'requested',
      'confirmed',
      'active',
      'completed',
    ]);
  });

  it('lets managers do every step', async () => {
    const created = await book();
    for (const step of ['confirm', 'start', 'complete']) {
      expect((await manager.post(`${BOOKINGS}/${created.id}/${step}`)).status, step).toBe(200);
    }
  });

  it('lets the front desk book and cancel but not confirm, start, complete or mark no-show', async () => {
    const created = await book();
    for (const step of ['confirm', 'start', 'complete', 'no-show']) {
      expect((await desk.post(`${BOOKINGS}/${created.id}/${step}`)).status, step).toBe(403);
    }
    expect(
      (await desk.post(`${BOOKINGS}/${created.id}/cancel`, { reason: 'Guest left' })).status,
    ).toBe(200);
  });

  it.each([
    ['start', 'requested'],
    ['complete', 'requested'],
    ['complete', 'confirmed'],
    ['confirm', 'confirmed'],
    ['confirm', 'active'],
    ['start', 'active'],
  ] as const)('refuses to %s a booking that is %s', async (step, state) => {
    const created = await book();
    if (state !== 'requested') await spa.post(`${BOOKINGS}/${created.id}/confirm`);
    if (state === 'active') await spa.post(`${BOOKINGS}/${created.id}/start`);
    const res = await spa.post(`${BOOKINGS}/${created.id}/${step}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('bad_transition');
    expect((await spa.get(`${BOOKINGS}/${created.id}`)).body.data.status).toBe(state);
  });

  it('cannot move a booking that is already completed, cancelled or marked no-show', async () => {
    const completed = await book();
    for (const step of ['confirm', 'start', 'complete']) {
      await spa.post(`${BOOKINGS}/${completed.id}/${step}`);
    }
    const cancelled = await book();
    await desk.post(`${BOOKINGS}/${cancelled.id}/cancel`, { reason: 'Guest left' });
    for (const done of [completed, cancelled]) {
      for (const step of ['confirm', 'start', 'complete', 'no-show']) {
        expect((await spa.post(`${BOOKINGS}/${done.id}/${step}`)).status, step).toBe(409);
      }
      expect(
        (await spa.post(`${BOOKINGS}/${done.id}/cancel`, { reason: 'Again please' })).status,
      ).toBe(409);
    }
  });

  it('can be cancelled while requested or confirmed, but not once it has started', async () => {
    const requested = await book();
    const confirmed = await book();
    await spa.post(`${BOOKINGS}/${confirmed.id}/confirm`);
    const active = await book();
    await spa.post(`${BOOKINGS}/${active.id}/confirm`);
    await spa.post(`${BOOKINGS}/${active.id}/start`);
    for (const ok of [requested, confirmed]) {
      const res = await spa.post(`${BOOKINGS}/${ok.id}/cancel`, { reason: 'Guest unwell' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'Guest unwell' });
      expect(res.body.data.cancelledAt).toBeTruthy();
    }
    const late = await spa.post(`${BOOKINGS}/${active.id}/cancel`, { reason: 'Too late' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('bad_transition');
  });

  it('needs a reason to cancel', async () => {
    const created = await book();
    expect((await desk.post(`${BOOKINGS}/${created.id}/cancel`, {})).status).toBe(400);
    expect((await desk.post(`${BOOKINGS}/${created.id}/cancel`, { reason: 'x' })).status).toBe(400);
  });

  it('keeps kitchen, housekeeping and maintenance staff out of every route', async () => {
    const created = await book();
    for (const role of ['kitchen', 'housekeeping', 'maintenance'] as const) {
      const client = await as(a, role);
      expect((await client.get(BOOKINGS)).status, role).toBe(403);
      expect((await client.get(`${BOOKINGS}/${created.id}`)).status, role).toBe(403);
      expect((await client.get(`${BOOKINGS}/summary?date=${day(1)}`)).status, role).toBe(403);
      expect(
        (
          await client.post(BOOKINGS, {
            facilityId: spaRoom.id,
            roomId: ids.rooms['101'],
            date: day(1),
            startTime: '09:00',
          })
        ).status,
        role,
      ).toBe(403);
      expect((await client.post(`${BOOKINGS}/${created.id}/confirm`)).status, role).toBe(403);
    }
    expect((await t.anonymous.get(BOOKINGS)).status).toBe(401);
  });

  it('answers 404 for an unknown booking and 400 for a malformed id', async () => {
    expect((await spa.get(`${BOOKINGS}/0123456789abcdef01234567`)).status).toBe(404);
    expect((await spa.get(`${BOOKINGS}/nope`)).status).toBe(400);
  });

  it('announces each step and audits it', async () => {
    const created = await book();
    const { events, stop } = capture();
    await spa.post(`${BOOKINGS}/${created.id}/confirm`);
    await spa.post(`${BOOKINGS}/${created.id}/start`);
    stop();
    const changes = events.filter((e) => e.type === 'facility_booking.changed');
    expect(changes.map((e) => (e.data as { change: string }).change)).toEqual([
      'confirmed',
      'started',
    ]);
    for (const event of changes) {
      expect(event.audience).toEqual({ departments: ['spa_recreation', 'front_desk'] });
    }
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ 'target.id': created.id }).lean(),
    );
    expect(audits.map((entry) => entry.action).sort()).toEqual([
      'facility_booking.confirmed',
      'facility_booking.created',
      'facility_booking.started',
    ]);
  });
});

describe('no-shows and past slots', () => {
  it('only allows a no-show once the slot time has passed', async () => {
    const created = await book();
    await spa.post(`${BOOKINGS}/${created.id}/confirm`);
    const early = await spa.post(`${BOOKINGS}/${created.id}/no-show`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('too_early');
    // Move the slot into the past, as if the day had arrived.
    await runWithTenant(a.id, () =>
      FacilityBooking.updateOne(
        { _id: created.id },
        { $set: { slotStart: new Date(Date.now() - 3 * 3_600_000) } },
      ),
    );
    const late = await spa.post(`${BOOKINGS}/${created.id}/no-show`);
    expect(late.status).toBe(200);
    expect(late.body.data.status).toBe('no_show');
  });

  it('cannot mark a booking that was never confirmed as a no-show', async () => {
    const created = await book();
    await runWithTenant(a.id, () =>
      FacilityBooking.updateOne(
        { _id: created.id },
        { $set: { slotStart: new Date(Date.now() - 3 * 3_600_000) } },
      ),
    );
    const res = await spa.post(`${BOOKINGS}/${created.id}/no-show`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('bad_transition');
  });
});

describe('the billing hook: facility_booking.completed', () => {
  const toActive = async (): Promise<FacilityBookingDto> => {
    // The studio takes 100 people, so each test can have its own booking in the same slot.
    const created = await book({ startTime: '13:00', participants: 2 });
    await spa.post(`${BOOKINGS}/${created.id}/confirm`);
    await spa.post(`${BOOKINGS}/${created.id}/start`);
    return created;
  };

  it('is emitted once, with the booking and the amount, when a booking is completed', async () => {
    const created = await toActive();
    const { events, stop } = capture();
    const res = await spa.post(`${BOOKINGS}/${created.id}/complete`);
    stop();
    expect(res.status).toBe(200);
    const hook = events.filter((e) => e.type === 'facility_booking.completed');
    expect(hook).toHaveLength(1);
    expect(hook[0]?.data).toEqual({
      facilityBookingId: created.id,
      bookingId: guestBooking,
      roomId: ids.rooms['101'],
      facilityName: 'Yoga Studio',
      facilityType: 'activity',
      date: day(1),
      participants: 2,
      totalPaise: 300_000,
    });
  });

  it('is for billing only: it is not sent to any screen', async () => {
    const created = await toActive();
    const { events, stop } = capture();
    await spa.post(`${BOOKINGS}/${created.id}/complete`);
    stop();
    expect(events.find((e) => e.type === 'facility_booking.completed')?.audience).toEqual({
      managers: false,
    });
  });

  it('is not emitted for any other step, nor for a cancellation', async () => {
    const created = await book();
    const { events, stop } = capture();
    await spa.post(`${BOOKINGS}/${created.id}/confirm`);
    await spa.post(`${BOOKINGS}/${created.id}/cancel`, { reason: 'Guest unwell' });
    stop();
    expect(events.filter((e) => e.type === 'facility_booking.completed')).toHaveLength(0);
  });

  it('is emitted exactly once when several people complete the same booking at once', async () => {
    const created = await toActive();
    const second = await addStaff(t, a, 'spa_recreation');
    const { events, stop } = capture();
    const results = await Promise.all([
      spa.post(`${BOOKINGS}/${created.id}/complete`),
      second.client.post(`${BOOKINGS}/${created.id}/complete`),
      manager.post(`${BOOKINGS}/${created.id}/complete`),
    ]);
    stop();
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(events.filter((e) => e.type === 'facility_booking.completed')).toHaveLength(1);
  });

  it('undoes the step when the audit write fails, tells billing nothing, and lets a retry succeed', async () => {
    const created = await toActive();
    const failing = vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit down'));
    const first = capture();
    const failed = await spa.post(`${BOOKINGS}/${created.id}/complete`);
    first.stop();
    failing.mockRestore();
    expect(failed.status).toBe(500);
    expect(first.events.filter((e) => e.type === 'facility_booking.completed')).toHaveLength(0);
    expect((await spa.get(`${BOOKINGS}/${created.id}`)).body.data.status).toBe('active');
    const second = capture();
    const retry = await spa.post(`${BOOKINGS}/${created.id}/complete`);
    second.stop();
    expect(retry.status).toBe(200);
    expect(second.events.filter((e) => e.type === 'facility_booking.completed')).toHaveLength(1);
  });
});

describe('the dashboard list and summary', () => {
  const date = day(3);
  let late: FacilityBookingDto;
  let early: FacilityBookingDto;
  let cancelled: FacilityBookingDto;

  beforeAll(async () => {
    // A guest whose stay covers the day being tested (the others leave on day 2).
    const longStay = await desk.post('/api/v1/bookings', {
      guest: { name: 'Long Stay Guest', phone: '+917000000913' },
      roomTypeId: ids.types.Deluxe,
      roomId: ids.rooms['104'],
      checkInDate: day(0),
      checkOutDate: day(6),
      adults: 1,
    });
    expect(longStay.status, JSON.stringify(longStay.body)).toBe(201);
    expect((await desk.post(`/api/v1/bookings/${longStay.body.data.id}/check-in`, {})).status).toBe(
      200,
    );

    const place = async (facility: FacilityDto, startTime: string, participants = 1) => {
      const res = await desk.post(BOOKINGS, {
        facilityId: facility.id,
        roomId: ids.rooms['104'],
        date,
        startTime,
        participants,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.data as FacilityBookingDto;
    };
    late = await place(spaRoom, '16:00');
    early = await place(pool, '09:00', 2);
    cancelled = await place(spaRoom, '11:00');
    await desk.post(`${BOOKINGS}/${cancelled.id}/cancel`, { reason: 'Guest left' });
    await spa.post(`${BOOKINGS}/${early.id}/confirm`);
  });

  it('lists a day’s bookings in time order, and filters by facility, status and open', async () => {
    const res = await spa.get(`${BOOKINGS}?date=${date}&limit=100`);
    expect(res.status).toBe(200);
    const listed = res.body.data as FacilityBookingDto[];
    expect(listed.map((x) => x.id)).toEqual([early.id, cancelled.id, late.id]);

    const open = await spa.get(`${BOOKINGS}?date=${date}&open=true&limit=100`);
    expect((open.body.data as FacilityBookingDto[]).map((x) => x.id)).toEqual([early.id, late.id]);
    const byFacility = await spa.get(`${BOOKINGS}?date=${date}&facilityId=${pool.id}`);
    expect((byFacility.body.data as FacilityBookingDto[]).map((x) => x.id)).toEqual([early.id]);
    const byStatus = await spa.get(`${BOOKINGS}?date=${date}&status=cancelled`);
    expect((byStatus.body.data as FacilityBookingDto[]).map((x) => x.id)).toEqual([cancelled.id]);
    expect((await spa.get(`${BOOKINGS}?limit=1000`)).status).toBe(400);
    expect((await spa.get(`${BOOKINGS}?status=burnt`)).status).toBe(400);
  });

  it('pages the list and reports the total', async () => {
    const res = await spa.get(`${BOOKINGS}?date=${date}&limit=2&page=2`);
    expect(res.body.meta).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(res.body.data).toHaveLength(1);
  });

  it('counts the day by status and the people expected in open slots', async () => {
    const res = await spa.get(`${BOOKINGS}/summary?date=${date}`);
    expect(res.status).toBe(200);
    const summary = res.body.data as FacilityBookingSummaryDto;
    expect(summary).toMatchObject({ date, participantsExpected: 3 });
    expect(summary.byStatus).toMatchObject({
      requested: 1,
      confirmed: 1,
      active: 0,
      completed: 0,
      cancelled: 1,
      no_show: 0,
    });
    expect((await spa.get(`${BOOKINGS}/summary`)).status).toBe(400);
  });

  it('never shows or lets another property touch a booking', async () => {
    expect((await otherManager.get(`${BOOKINGS}/${late.id}`)).status).toBe(404);
    expect((await otherManager.post(`${BOOKINGS}/${late.id}/confirm`)).status).toBe(404);
    expect(
      (await otherManager.post(`${BOOKINGS}/${late.id}/cancel`, { reason: 'not yours' })).status,
    ).toBe(404);
    const theirs = await otherManager.get(`${BOOKINGS}?date=${date}&limit=100`);
    expect(theirs.body.data).toHaveLength(0);
  });
});

describe('the facility booking routes are in the API documentation', () => {
  it('lists them', async () => {
    const res = await request(t.app).get('/openapi.json');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/facility-bookings',
        '/api/v1/facility-bookings/summary',
        '/api/v1/facility-bookings/{id}',
        '/api/v1/facility-bookings/{id}/confirm',
        '/api/v1/facility-bookings/{id}/start',
        '/api/v1/facility-bookings/{id}/complete',
        '/api/v1/facility-bookings/{id}/no-show',
        '/api/v1/facility-bookings/{id}/cancel',
      ]),
    );
  });
});
