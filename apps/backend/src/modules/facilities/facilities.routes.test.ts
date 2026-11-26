import type { StaffRole } from '@hospitality/constants';
import type { FacilityDto, FacilitySlotDto } from '@hospitality/shared-types';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { checkInGuest, day, lookup, type Lookup } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Facility } from './facility.model';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
let ids: Lookup;
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

const FACILITIES = '/api/v1/facilities';
const BOOKINGS = '/api/v1/facility-bookings';

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await as(a, 'manager');
  desk = await as(a, 'front_desk');
  spa = await as(a, 'spa_recreation');
  otherManager = await as(b, 'manager');
  ids = await lookup(desk);
  await checkInGuest(desk, ids, '101', 'Standard', '+917000000901');
});

let counter = 0;
const facility = (extra: Record<string, unknown> = {}) => ({
  name: `Facility ${++counter}`,
  type: 'spa',
  capacity: 1,
  slotMinutes: 60,
  opensAt: '09:00',
  closesAt: '18:00',
  pricePaise: 150_000,
  ...extra,
});

async function addFacility(
  client: Client = manager,
  extra: Record<string, unknown> = {},
): Promise<FacilityDto> {
  const res = await client.post(FACILITIES, facility(extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as FacilityDto;
}

describe('creating facilities', () => {
  it('lets management add a facility and fills the defaults', async () => {
    const res = await manager.post(FACILITIES, {
      name: 'Ayurvedic Spa',
      type: 'spa',
      capacity: 2,
      slotMinutes: 90,
      opensAt: '10:00',
      closesAt: '19:30',
      pricePaise: 250_000,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Ayurvedic Spa',
      type: 'spa',
      description: '',
      capacity: 2,
      slotMinutes: 90,
      opensAt: '10:00',
      closesAt: '19:30',
      pricePaise: 250_000,
      active: true,
    });
  });

  it('audits who added it', async () => {
    const created = await addFacility();
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'facility.created', 'target.id': created.id }).lean(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toMatchObject({ id: a.staff.manager?.id.toHexString() });
  });

  it('refuses the same name twice in one property, whatever the case, but not across properties', async () => {
    await addFacility(manager, { name: 'Rooftop Pool' });
    const again = await manager.post(FACILITIES, facility({ name: ' rooftop POOL ' }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('duplicate_facility');
    expect((await otherManager.post(FACILITIES, facility({ name: 'Rooftop Pool' }))).status).toBe(
      201,
    );
  });

  it('ignores a property id sent by the client', async () => {
    const res = await manager.post(FACILITIES, facility({ propertyId: b.id.toHexString() }));
    expect(res.status).toBe(201);
    expect(
      await runWithTenant(b.id, () => Facility.countDocuments({ _id: res.body.data.id })),
    ).toBe(0);
    expect(
      await runWithTenant(a.id, () => Facility.countDocuments({ _id: res.body.data.id })),
    ).toBe(1);
  });

  it('rejects bad hours, slot lengths, capacities and prices with a 400', async () => {
    for (const bad of [
      facility({ opensAt: '18:00', closesAt: '09:00' }),
      facility({ opensAt: '09:00', closesAt: '09:30', slotMinutes: 60 }),
      facility({ slotMinutes: 7 }),
      facility({ capacity: 0 }),
      facility({ pricePaise: -5 }),
      facility({ type: 'casino' }),
      facility({ name: '' }),
    ]) {
      const res = await manager.post(FACILITIES, bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
  });
});

describe('who may manage and who may read facilities', () => {
  it('lets only management add or change facilities', async () => {
    const existing = await addFacility();
    for (const role of [
      'front_desk',
      'spa_recreation',
      'kitchen',
      'housekeeping',
      'maintenance',
    ] as const) {
      const client = await as(a, role);
      expect((await client.post(FACILITIES, facility())).status, role).toBe(403);
      expect(
        (await client.patch(`${FACILITIES}/${existing.id}`, { pricePaise: 1 })).status,
        role,
      ).toBe(403);
    }
    expect((await (await as(a, 'property_admin')).post(FACILITIES, facility())).status).toBe(201);
  });

  it('lets spa staff, the front desk and management read, and keeps the rest out', async () => {
    for (const role of ['spa_recreation', 'front_desk', 'manager', 'property_admin'] as const) {
      expect((await (await as(a, role)).get(FACILITIES)).status, role).toBe(200);
    }
    for (const role of ['kitchen', 'housekeeping', 'maintenance'] as const) {
      expect((await (await as(a, role)).get(FACILITIES)).status, role).toBe(403);
    }
    expect((await t.anonymous.get(FACILITIES)).status).toBe(401);
  });
});

describe('listing and reading', () => {
  it('lists by type then name with filters, paging, and never shows another property', async () => {
    const tag = `Zz${Date.now()}`;
    await addFacility(manager, { name: `${tag} Yoga`, type: 'activity' });
    await addFacility(manager, { name: `${tag} Gym`, type: 'gym' });
    const hidden = await addFacility(manager, { name: `${tag} Steam`, type: 'spa' });
    await manager.patch(`${FACILITIES}/${hidden.id}`, { active: false });

    const all = await spa.get(`${FACILITIES}?limit=100`);
    const mine = (all.body.data as FacilityDto[]).filter((f) => f.name.startsWith(tag));
    expect(mine.map((f) => f.type)).toEqual(['activity', 'gym', 'spa']);

    const active = await spa.get(`${FACILITIES}?active=true&limit=100`);
    expect((active.body.data as FacilityDto[]).some((f) => f.id === hidden.id)).toBe(false);
    const gyms = await spa.get(`${FACILITIES}?type=gym&limit=100`);
    expect((gyms.body.data as FacilityDto[]).every((f) => f.type === 'gym')).toBe(true);

    const page = await spa.get(`${FACILITIES}?limit=1&page=2`);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta.total).toBeGreaterThan(1);

    const theirs = await otherManager.get(`${FACILITIES}?limit=100`);
    expect((theirs.body.data as FacilityDto[]).some((f) => f.name.startsWith(tag))).toBe(false);
  });

  it('answers 404 for an unknown or other-property facility and 400 for a malformed id', async () => {
    const mine = await addFacility();
    expect((await manager.get(`${FACILITIES}/0123456789abcdef01234567`)).status).toBe(404);
    expect((await manager.get(`${FACILITIES}/nope`)).status).toBe(400);
    expect((await otherManager.get(`${FACILITIES}/${mine.id}`)).status).toBe(404);
  });
});

describe('changing facilities', () => {
  it('changes only the fields that were sent, and audits a price change', async () => {
    const created = await addFacility(manager, { description: 'Quiet', pricePaise: 100_000 });
    const res = await manager.patch(`${FACILITIES}/${created.id}`, { pricePaise: 120_000 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      description: 'Quiet',
      pricePaise: 120_000,
      capacity: 1,
      opensAt: '09:00',
    });
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'facility.updated', 'target.id': created.id }).lean(),
    );
    expect(audits[0]?.summary).toMatchObject({
      fields: ['pricePaise'],
      previousPricePaise: 100_000,
      pricePaise: 120_000,
    });
  });

  it('refuses an empty change, a duplicate name and an unknown facility', async () => {
    const one = await addFacility(manager, { name: 'Rename Me' });
    await addFacility(manager, { name: 'Taken Name' });
    expect((await manager.patch(`${FACILITIES}/${one.id}`, {})).status).toBe(400);
    const dup = await manager.patch(`${FACILITIES}/${one.id}`, { name: 'taken name' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_facility');
    expect(
      (await manager.patch(`${FACILITIES}/0123456789abcdef01234567`, { pricePaise: 1 })).status,
    ).toBe(404);
  });

  it('checks the hours together: moving only the closing time before the opening time is refused', async () => {
    const created = await addFacility(manager, { opensAt: '09:00', closesAt: '18:00' });
    const res = await manager.patch(`${FACILITIES}/${created.id}`, { closesAt: '08:00' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    const tooShort = await manager.patch(`${FACILITIES}/${created.id}`, { slotMinutes: 600 });
    expect(tooShort.status).toBe(400);
  });

  it('cannot touch another property’s facility', async () => {
    const mine = await addFacility();
    expect((await otherManager.patch(`${FACILITIES}/${mine.id}`, { active: false })).status).toBe(
      404,
    );
    expect((await manager.get(`${FACILITIES}/${mine.id}`)).body.data.active).toBe(true);
  });

  it('does not let the schedule or capacity change while open bookings hold slots, but allows the price', async () => {
    const created = await addFacility(manager, { capacity: 2 });
    const book = await desk.post(BOOKINGS, {
      facilityId: created.id,
      roomId: ids.rooms['101'],
      date: day(1),
      startTime: '10:00',
      participants: 1,
    });
    expect(book.status, JSON.stringify(book.body)).toBe(201);

    for (const change of [
      { slotMinutes: 30 },
      { opensAt: '08:00' },
      { closesAt: '17:00' },
      { capacity: 5 },
    ]) {
      const res = await manager.patch(`${FACILITIES}/${created.id}`, change);
      expect(res.status, JSON.stringify(change)).toBe(409);
      expect(res.body.error.code).toBe('facility_in_use');
    }
    expect((await manager.patch(`${FACILITIES}/${created.id}`, { pricePaise: 1 })).status).toBe(
      200,
    );
    expect((await manager.patch(`${FACILITIES}/${created.id}`, { name: 'Renamed' })).status).toBe(
      200,
    );

    // Once the booking is cancelled nothing holds the schedule any more.
    await desk.post(`${BOOKINGS}/${book.body.data.id}/cancel`, { reason: 'Changed plans' });
    expect((await manager.patch(`${FACILITIES}/${created.id}`, { slotMinutes: 30 })).status).toBe(
      200,
    );
  });
});

describe('the slots of a day', () => {
  it('lists every slot with its capacity, bookings and whether it can be booked', async () => {
    const pool = await addFacility(manager, {
      name: 'Slots Pool',
      type: 'pool',
      capacity: 3,
      slotMinutes: 120,
      opensAt: '08:00',
      closesAt: '14:00',
    });
    const res = await spa.get(`${FACILITIES}/${pool.id}/slots?date=${day(1)}`);
    expect(res.status).toBe(200);
    const slots = res.body.data as FacilitySlotDto[];
    expect(slots.map((s) => `${s.startTime}-${s.endTime}`)).toEqual([
      '08:00-10:00',
      '10:00-12:00',
      '12:00-14:00',
    ]);
    for (const slot of slots) {
      expect(slot).toMatchObject({
        capacity: 3,
        booked: 0,
        remaining: 3,
        past: false,
        bookable: true,
      });
    }
  });

  it('shows bookings taking up capacity, a full slot as not bookable, and a cancellation freeing it', async () => {
    const pool = await addFacility(manager, {
      name: 'Capacity Pool',
      type: 'pool',
      capacity: 2,
      slotMinutes: 60,
      opensAt: '09:00',
      closesAt: '12:00',
    });
    const book = (participants: number) =>
      desk.post(BOOKINGS, {
        facilityId: pool.id,
        roomId: ids.rooms['101'],
        date: day(1),
        startTime: '09:00',
        participants,
      });
    const first = await book(1);
    expect(first.status).toBe(201);
    let slot = (
      (await spa.get(`${FACILITIES}/${pool.id}/slots?date=${day(1)}`)).body
        .data as FacilitySlotDto[]
    )[0];
    expect(slot).toMatchObject({ booked: 1, remaining: 1, bookable: true });

    const second = await book(1);
    expect(second.status).toBe(201);
    slot = (
      (await spa.get(`${FACILITIES}/${pool.id}/slots?date=${day(1)}`)).body
        .data as FacilitySlotDto[]
    )[0];
    expect(slot).toMatchObject({ booked: 2, remaining: 0, bookable: false });

    await desk.post(`${BOOKINGS}/${first.body.data.id}/cancel`, { reason: 'Guest unwell' });
    slot = (
      (await spa.get(`${FACILITIES}/${pool.id}/slots?date=${day(1)}`)).body
        .data as FacilitySlotDto[]
    )[0];
    expect(slot).toMatchObject({ booked: 1, remaining: 1, bookable: true });
  });

  it('marks slots that have already started as past, and never bookable', async () => {
    const gym = await addFacility(manager, {
      name: 'All Day Gym',
      type: 'gym',
      capacity: 5,
      slotMinutes: 60,
      opensAt: '00:00',
      closesAt: '23:59',
    });
    const slots = (await spa.get(`${FACILITIES}/${gym.id}/slots?date=${day(0)}`)).body
      .data as FacilitySlotDto[];
    expect(slots[0]).toMatchObject({ startTime: '00:00', past: true, bookable: false });
    const yesterday = (await spa.get(`${FACILITIES}/${gym.id}/slots?date=${day(-1)}`)).body
      .data as FacilitySlotDto[];
    expect(yesterday.every((s) => s.past && !s.bookable)).toBe(true);
    const later = (await spa.get(`${FACILITIES}/${gym.id}/slots?date=${day(5)}`)).body
      .data as FacilitySlotDto[];
    expect(later.every((s) => !s.past && s.bookable)).toBe(true);
  });

  it('refuses a bad date, an unknown facility and another property’s facility', async () => {
    const pool = await addFacility();
    expect((await spa.get(`${FACILITIES}/${pool.id}/slots?date=2026-02-30`)).status).toBe(400);
    expect((await spa.get(`${FACILITIES}/${pool.id}/slots`)).status).toBe(400);
    expect(
      (await spa.get(`${FACILITIES}/0123456789abcdef01234567/slots?date=${day(1)}`)).status,
    ).toBe(404);
    expect((await otherManager.get(`${FACILITIES}/${pool.id}/slots?date=${day(1)}`)).status).toBe(
      404,
    );
  });
});

describe('the facility routes are in the API documentation', () => {
  it('lists them', async () => {
    const res = await request(t.app).get('/openapi.json');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/facilities',
        '/api/v1/facilities/{id}',
        '/api/v1/facilities/{id}/slots',
      ]),
    );
  });
});
