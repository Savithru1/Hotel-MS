import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../test/db';
import { checkInGuest, day, lookup, today, type Lookup } from '../../test/fixtures';
import { buildTestApp, type Client } from '../../test/http';
import { runWithTenant } from '../shared/request-context';
import { Room } from './rooms/room.model';
import { seedDevelopmentData, type SeededProperty } from './seed/seed';
import { ServiceRequest } from './service-requests/service-request.model';

useTestDatabase();

/** Regression tests for problems found in the independent review of P1.5 to P1.7. */
let a: SeededProperty;
let ids: Lookup;
let desk: Client;
let manager: Client;
let housekeeper: Client;
let technician: Client;
const t = buildTestApp();

const as = (role: 'front_desk' | 'manager' | 'housekeeping' | 'maintenance'): Promise<Client> =>
  t.actAs(a.staff[role]?.id ?? a.id, a.id);

const roomStatus = async (number: string) =>
  (await runWithTenant(a.id, () => Room.findOne({ _id: ids.rooms[number] }).lean()))?.status;
const setRoom = (number: string, status: string) =>
  runWithTenant(a.id, () => Room.updateOne({ _id: ids.rooms[number] }, { status }));

beforeAll(async () => {
  [a] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  desk = await as('front_desk');
  manager = await as('manager');
  housekeeper = await as('housekeeping');
  technician = await as('maintenance');
  ids = await lookup(desk);
  await checkInGuest(desk, ids, '101', 'Standard', '+917000000101');
});

describe('manual room changes cannot undo what check-in and maintenance decide', () => {
  it('refuses to change a room with a guest in it', async () => {
    for (const status of ['cleaning', 'available', 'out_of_service']) {
      const res = await desk.post(`/api/v1/rooms/${ids.rooms['101']}/status`, { status });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('room_occupied');
    }
    expect(await roomStatus('101')).toBe('occupied');
  });

  it('refuses to release a room that an open maintenance issue holds out of service', async () => {
    const issue = await desk.post('/api/v1/maintenance', {
      roomId: ids.rooms['102'],
      category: 'plumbing',
      description: 'Pipe burst under the sink',
      takeRoomOutOfService: true,
    });
    expect(issue.status).toBe(201);
    const res = await desk.post(`/api/v1/rooms/${ids.rooms['102']}/status`, {
      status: 'available',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('held_by_maintenance');
    expect(await roomStatus('102')).toBe('maintenance');

    // Once the issue is resolved the room is released by that, not by hand.
    await manager.post(`/api/v1/maintenance/${issue.body.data.id}/assign`, {
      staffId: a.staff.maintenance?.id.toHexString(),
    });
    await technician.post(`/api/v1/maintenance/${issue.body.data.id}/start`);
    await technician.post(`/api/v1/maintenance/${issue.body.data.id}/resolve`, {
      resolutionNote: 'Replaced the pipe',
    });
    expect(await roomStatus('102')).toBe('available');
  });

  it('still lets the front desk bring an ordinary out-of-service room back', async () => {
    await desk.post(`/api/v1/rooms/${ids.rooms['103']}/status`, { status: 'out_of_service' });
    const res = await desk.post(`/api/v1/rooms/${ids.rooms['103']}/status`, {
      status: 'available',
    });
    expect(res.status).toBe(200);
  });

  it('still refuses a move the table does not allow', async () => {
    await setRoom('105', 'reserved');
    const res = await desk.post(`/api/v1/rooms/${ids.rooms['105']}/status`, { status: 'cleaning' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('bad_transition');
    await setRoom('105', 'available');
  });
});

describe('resolving maintenance does not skip a cleaning that is still owed', () => {
  it('puts the room back to cleaning when a cleaning task is still open, and the cleaner then frees it', async () => {
    await setRoom('201', 'cleaning');
    const cleaning = await desk.post('/api/v1/housekeeping', {
      roomId: ids.rooms['201'],
      type: 'room_cleaning',
    });
    const issue = await desk.post('/api/v1/maintenance', {
      roomId: ids.rooms['201'],
      category: 'tv',
      description: 'TV will not turn on',
      takeRoomOutOfService: true,
    });
    expect(await roomStatus('201')).toBe('maintenance');

    await manager.post(`/api/v1/maintenance/${issue.body.data.id}/assign`, {
      staffId: a.staff.maintenance?.id.toHexString(),
    });
    await technician.post(`/api/v1/maintenance/${issue.body.data.id}/start`);
    await technician.post(`/api/v1/maintenance/${issue.body.data.id}/resolve`, {
      resolutionNote: 'New TV fitted',
    });
    expect(await roomStatus('201')).toBe('cleaning');

    await housekeeper.post(`/api/v1/housekeeping/${cleaning.body.data.id}/start`);
    await housekeeper.post(`/api/v1/housekeeping/${cleaning.body.data.id}/complete`, {});
    expect(await roomStatus('201')).toBe('available');
  });
});

describe('a room with bookings cannot be retired', () => {
  it('refuses while a confirmed or in-house booking holds the room', async () => {
    const booking = await desk.post('/api/v1/bookings', {
      guest: { name: 'Future Guest', phone: '+917000000222' },
      roomTypeId: ids.types.Deluxe,
      roomId: ids.rooms['203'],
      checkInDate: day(40),
      checkOutDate: day(42),
      adults: 1,
    });
    expect(booking.status).toBe(201);
    const res = await manager.patch(`/api/v1/rooms/${ids.rooms['203']}`, { active: false });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('room_in_use');

    await desk.post(`/api/v1/bookings/${booking.body.data.id}/cancel`, { reason: 'Changed plans' });
    expect(
      (await manager.patch(`/api/v1/rooms/${ids.rooms['203']}`, { active: false })).status,
    ).toBe(200);
  });
});

describe('dates must be real calendar dates', () => {
  it.each(['2026-02-31', '2026-04-31', '2027-02-29'])('refuses %s when booking', async (date) => {
    const res = await desk.post('/api/v1/bookings', {
      guest: { name: 'Date Tester', phone: '+917000000333' },
      roomTypeId: ids.types.Standard,
      checkInDate: date,
      checkOutDate: day(500),
      adults: 1,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/real date/);
  });

  it('refuses them in availability searches and the calendar too', async () => {
    expect(
      (
        await desk.get(
          '/api/v1/bookings/availability?checkInDate=2026-02-31&checkOutDate=2026-03-02',
        )
      ).status,
    ).toBe(400);
    expect((await desk.get(`/api/v1/bookings/calendar?from=2026-02-31&to=${today()}`)).status).toBe(
      400,
    );
  });
});

describe('searching bookings', () => {
  it('does not return every booking for a query made only of separators', async () => {
    await desk.post('/api/v1/bookings', {
      guest: { name: 'Searchable One', phone: '+917000000444' },
      roomTypeId: ids.types.Standard,
      checkInDate: day(60),
      checkOutDate: day(61),
      adults: 1,
    });
    const res = await desk.get('/api/v1/bookings?q=--');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('finished housekeeping work no longer shows as escalated', () => {
  it('clears the flag on completion and on cancellation', async () => {
    const one = (
      await desk.post('/api/v1/housekeeping', { roomId: ids.rooms['204'], type: 'room_cleaning' })
    ).body.data;
    await housekeeper.post(`/api/v1/housekeeping/${one.id}/escalate`, {
      reason: 'Guest is waiting',
    });
    await housekeeper.post(`/api/v1/housekeeping/${one.id}/start`);
    const done = await housekeeper.post(`/api/v1/housekeeping/${one.id}/complete`, {});
    expect(done.body.data.escalated).toBe(false);

    const two = (
      await desk.post('/api/v1/housekeeping', { roomId: ids.rooms['205'], type: 'room_cleaning' })
    ).body.data;
    await desk.post(`/api/v1/housekeeping/${two.id}/escalate`, { reason: 'Urgent' });
    const cancelled = await desk.post(`/api/v1/housekeeping/${two.id}/cancel`, {
      reason: 'Logged twice',
    });
    expect(cancelled.body.data.escalated).toBe(false);
    const stored = await runWithTenant(a.id, () => ServiceRequest.findOne({ _id: two.id }).lean());
    expect(stored?.escalated).toBe(false);
  });
});
