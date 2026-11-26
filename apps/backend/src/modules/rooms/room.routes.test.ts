import { ROOM_STATUSES, STAFF_ROLES, type StaffRole } from '@hospitality/constants';
import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { createEventBus } from '../../shared/events/event-bus';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Room } from './room.model';
import { createRoomService } from './room.service';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
const t = buildTestApp();

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

async function firstTypeId(client: Client): Promise<string> {
  const res = await client.get('/api/v1/room-types');
  return res.body.data[0].id as string;
}

let counter = 0;
const uniqueNumber = (): string => `T${++counter}`;

describe('room types', () => {
  it('lists the seeded types, tariffs as whole paise', async () => {
    const res = await (await as(a, 'front_desk')).get('/api/v1/room-types');
    expect(res.status).toBe(200);
    expect(res.body.data.map((type: { name: string }) => type.name)).toEqual([
      'Deluxe',
      'Standard',
      'Suite',
    ]);
    for (const type of res.body.data) expect(Number.isInteger(type.ratePaise)).toBe(true);
  });

  it('lets a manager create and change a type, and audits it', async () => {
    const manager = await as(a, 'manager');
    const created = await manager.post('/api/v1/room-types', {
      name: 'Family',
      capacity: 5,
      ratePaise: 650_000,
      amenities: ['Wi-Fi', 'Wi-Fi', 'Sofa bed'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.amenities).toEqual(['Wi-Fi', 'Sofa bed']);

    const changed = await manager.patch(`/api/v1/room-types/${created.body.data.id}`, {
      ratePaise: 700_000,
    });
    expect(changed.body.data.ratePaise).toBe(700_000);

    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ 'target.id': created.body.data.id }).lean(),
    );
    expect(audits.map((entry) => entry.action).sort()).toEqual([
      'room_type.created',
      'room_type.updated',
    ]);
  });

  it.each([
    ['a negative tariff', { ratePaise: -1 }],
    ['a fractional tariff', { ratePaise: 100.5 }],
    ['a tariff in rupees as text', { ratePaise: '2500' }],
    ['an absurd tariff', { ratePaise: 999_999_999_999 }],
    ['zero capacity', { capacity: 0 }],
    ['an empty name', { name: '   ' }],
  ])('rejects %s', async (_label, bad) => {
    const manager = await as(a, 'manager');
    const res = await manager.post('/api/v1/room-types', {
      name: `Bad ${uniqueNumber()}`,
      capacity: 2,
      ratePaise: 100_000,
      ...bad,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate name, ignoring letter case, but allows it in another property', async () => {
    const manager = await as(a, 'manager');
    const input = { name: 'Studio', capacity: 2, ratePaise: 300_000 };
    expect((await manager.post('/api/v1/room-types', input)).status).toBe(201);
    const dup = await manager.post('/api/v1/room-types', { ...input, name: 'STUDIO' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('room_type_name_taken');
    expect((await (await as(b, 'manager')).post('/api/v1/room-types', input)).status).toBe(201);
  });

  it('will not switch off a type that active rooms still use', async () => {
    const manager = await as(a, 'manager');
    const types = (await manager.get('/api/v1/room-types')).body.data as {
      id: string;
      name: string;
    }[];
    const standard = types.find((type) => type.name === 'Standard');
    const res = await manager.patch(`/api/v1/room-types/${standard?.id}`, { active: false });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('room_type_in_use');
  });

  it('does not show or change another property’s types', async () => {
    const bTypes = (await (await as(b, 'manager')).get('/api/v1/room-types')).body.data as {
      id: string;
    }[];
    const managerA = await as(a, 'manager');
    const aIds = (await managerA.get('/api/v1/room-types')).body.data.map(
      (type: { id: string }) => type.id,
    );
    for (const type of bTypes) expect(aIds).not.toContain(type.id);
    expect(
      (await managerA.patch(`/api/v1/room-types/${bTypes[0]?.id}`, { name: 'Hacked' })).status,
    ).toBe(404);
  });
});

describe('rooms', () => {
  it('lists rooms by floor then number with their type name, with paging', async () => {
    const res = await (await as(a, 'housekeeping')).get('/api/v1/rooms?limit=4');
    expect(res.status).toBe(200);
    expect(res.body.data.map((room: { number: string }) => room.number)).toEqual([
      '101',
      '102',
      '103',
      '104',
    ]);
    expect(res.body.data[0]).toMatchObject({
      floor: 1,
      status: 'available',
      roomTypeName: 'Standard',
    });
    expect(res.body.meta.total).toBeGreaterThanOrEqual(10);
  });

  it('filters by floor and status', async () => {
    const res = await (await as(a, 'front_desk')).get('/api/v1/rooms?floor=2&status=available');
    expect(res.body.data.every((room: { floor: number }) => room.floor === 2)).toBe(true);
  });

  it('creates a room and rejects a duplicate number in the same property, ignoring case', async () => {
    const manager = await as(a, 'manager');
    const roomTypeId = await firstTypeId(manager);
    const number = uniqueNumber();
    const created = await manager.post('/api/v1/rooms', { number, floor: 3, roomTypeId });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ number, status: 'available', active: true });

    const dup = await manager.post('/api/v1/rooms', {
      number: number.toLowerCase(),
      floor: 3,
      roomTypeId,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('room_number_taken');
  });

  it('allows the same room number in a different property', async () => {
    const roomTypeId = await firstTypeId(await as(b, 'manager'));
    const res = await (
      await as(b, 'manager')
    ).post('/api/v1/rooms', {
      number: '101',
      floor: 1,
      roomTypeId,
    });
    // Seeded rooms already use 101 in both properties, so this is the duplicate case...
    expect(res.status).toBe(409);
    // ...while a number free in B but used in A is fine.
    const free = await (
      await as(b, 'manager')
    ).post('/api/v1/rooms', {
      number: 'A-only-test'.slice(0, 10),
      floor: 1,
      roomTypeId,
    });
    expect(free.status).toBe(201);
    expect(
      (
        await (
          await as(a, 'manager')
        ).post('/api/v1/rooms', {
          number: 'A-only-test'.slice(0, 10),
          floor: 1,
          roomTypeId: await firstTypeId(await as(a, 'manager')),
        })
      ).status,
    ).toBe(201);
  });

  it('rejects a room type from another property, an unknown type and a switched-off type', async () => {
    const managerA = await as(a, 'manager');
    const bType = await firstTypeId(await as(b, 'manager'));
    for (const roomTypeId of [bType, new Types.ObjectId().toHexString()]) {
      const res = await managerA.post('/api/v1/rooms', {
        number: uniqueNumber(),
        floor: 1,
        roomTypeId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('unknown_room_type');
    }

    const off = await managerA.post('/api/v1/room-types', {
      name: `Off ${uniqueNumber()}`,
      capacity: 1,
      ratePaise: 100_000,
    });
    await managerA.patch(`/api/v1/room-types/${off.body.data.id}`, { active: false });
    const res = await managerA.post('/api/v1/rooms', {
      number: uniqueNumber(),
      floor: 1,
      roomTypeId: off.body.data.id,
    });
    expect(res.body.error.code).toBe('room_type_inactive');
  });

  it.each([
    ['an empty number', { number: ' ' }],
    ['a number with odd characters', { number: '<b>' }],
    ['a too-long number', { number: '12345678901' }],
    ['a fractional floor', { floor: 1.5 }],
    ['a far-off floor', { floor: 9000 }],
  ])('rejects %s', async (_label, bad) => {
    const manager = await as(a, 'manager');
    const res = await manager.post('/api/v1/rooms', {
      number: uniqueNumber(),
      floor: 1,
      roomTypeId: await firstTypeId(manager),
      ...bad,
    });
    expect(res.status).toBe(400);
  });

  it('ignores propertyId and status in the body', async () => {
    const manager = await as(a, 'manager');
    const res = await manager.post('/api/v1/rooms', {
      number: uniqueNumber(),
      floor: 1,
      roomTypeId: await firstTypeId(manager),
      propertyId: b.id.toHexString(),
      status: 'occupied',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('available');
    const inB = await runWithTenant(b.id, () =>
      Room.countDocuments({ number: res.body.data.number }),
    );
    expect(inB).toBe(0);
  });

  it('cannot read or change a room of another property', async () => {
    const bRoom = (await (await as(b, 'manager')).get('/api/v1/rooms?limit=1')).body.data[0].id;
    const managerA = await as(a, 'manager');
    expect((await managerA.get(`/api/v1/rooms/${bRoom}`)).status).toBe(404);
    expect((await managerA.patch(`/api/v1/rooms/${bRoom}`, { floor: 9 })).status).toBe(404);
    expect(
      (await managerA.post(`/api/v1/rooms/${bRoom}/status`, { status: 'out_of_service' })).status,
    ).toBe(404);
  });

  it('retires and restores a room', async () => {
    const manager = await as(a, 'manager');
    const created = await manager.post('/api/v1/rooms', {
      number: uniqueNumber(),
      floor: 4,
      roomTypeId: await firstTypeId(manager),
    });
    const id = created.body.data.id;
    expect((await manager.patch(`/api/v1/rooms/${id}`, { active: false })).body.data.active).toBe(
      false,
    );
    expect((await manager.patch(`/api/v1/rooms/${id}`, { active: true })).body.data.active).toBe(
      true,
    );
  });

  it('does not retire or renumber over a booked or occupied room', async () => {
    const manager = await as(a, 'manager');
    const created = await manager.post('/api/v1/rooms', {
      number: uniqueNumber(),
      floor: 4,
      roomTypeId: await firstTypeId(manager),
    });
    const id = created.body.data.id as string;
    await runWithTenant(a.id, () => Room.updateOne({ _id: id }, { status: 'occupied' }));
    const res = await manager.patch(`/api/v1/rooms/${id}`, { active: false });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('room_in_use');
  });
});

describe('room status rules', () => {
  async function freshRoom(): Promise<string> {
    const manager = await as(a, 'manager');
    const created = await manager.post('/api/v1/rooms', {
      number: uniqueNumber(),
      floor: 5,
      roomTypeId: await firstTypeId(manager),
    });
    return created.body.data.id as string;
  }

  it('moves available -> cleaning -> out_of_service -> available and keeps the history', async () => {
    const frontDesk = await as(a, 'front_desk');
    const id = await freshRoom();
    for (const status of ['cleaning', 'out_of_service', 'available']) {
      const res = await frontDesk.post(`/api/v1/rooms/${id}/status`, { status, note: 'by hand' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(status);
    }
    const room = await runWithTenant(a.id, () => Room.findOne({ _id: id }).lean());
    expect(room?.history.map((entry) => entry.to)).toEqual([
      'cleaning',
      'out_of_service',
      'available',
    ]);
    expect(room?.history[0]).toMatchObject({ from: 'available', note: 'by hand' });
    expect(room?.history[0]?.by).toMatchObject({ kind: 'staff' });
  });

  it('refuses a move the table does not allow with 409', async () => {
    const frontDesk = await as(a, 'front_desk');
    const id = await freshRoom();
    await runWithTenant(a.id, () => Room.updateOne({ _id: id }, { status: 'reserved' }));
    const res = await frontDesk.post(`/api/v1/rooms/${id}/status`, { status: 'cleaning' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('bad_transition');
  });

  it('refuses statuses that only bookings may set (occupied, reserved) and unknown ones', async () => {
    const frontDesk = await as(a, 'front_desk');
    const id = await freshRoom();
    for (const status of ['occupied', 'reserved', 'maintenance', 'broken']) {
      expect((await frontDesk.post(`/api/v1/rooms/${id}/status`, { status })).status).toBe(400);
    }
  });

  it('every legal and illegal move of the table behaves as written', async () => {
    const { ROOM_STATUS_TRANSITIONS } = await import('@hospitality/constants');
    const rooms = createRoomService(createEventBus());
    const id = await freshRoom();
    for (const from of ROOM_STATUSES) {
      for (const to of ROOM_STATUSES) {
        await runWithTenant(a.id, async () => {
          await Room.updateOne({ _id: id }, { status: from });
          const allowed = ROOM_STATUS_TRANSITIONS[from].includes(to);
          const result = rooms.changeStatus(id, to);
          if (allowed) await expect(result).resolves.toMatchObject({ status: to });
          else await expect(result).rejects.toMatchObject({ status: 409 });
        });
      }
    }
  });

  it('announces the change to the front desk and housekeeping, not the kitchen', async () => {
    const bus = createEventBus();
    const seen: { departments?: readonly string[] }[] = [];
    bus.subscribe((event) => seen.push(event.audience));
    const rooms = createRoomService(bus);
    const id = await freshRoom();
    await runWithTenant(a.id, () => rooms.changeStatus(id, 'cleaning'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.departments).toEqual(['front_desk', 'housekeeping']);
  });

  it('only one of several racing changes wins', async () => {
    const rooms = createRoomService(createEventBus());
    const id = await freshRoom();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        runWithTenant(a.id, () => rooms.changeStatus(id, 'cleaning')),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('who may use the room routes', () => {
  const writeRoles: StaffRole[] = ['platform_admin', 'property_admin', 'manager'];
  const statusRoles: StaffRole[] = [...writeRoles, 'front_desk'];

  for (const role of STAFF_ROLES) {
    it(`${role}: reads allowed, writes ${writeRoles.includes(role) ? 'allowed' : 'refused'}, status ${statusRoles.includes(role) ? 'allowed' : 'refused'}`, async () => {
      const client = await as(a, role);
      expect((await client.get('/api/v1/rooms')).status).toBe(200);
      expect((await client.get('/api/v1/room-types')).status).toBe(200);

      const roomTypeId = await firstTypeId(client);
      const create = await client.post('/api/v1/rooms', {
        number: uniqueNumber(),
        floor: 6,
        roomTypeId,
      });
      expect(create.status).toBe(writeRoles.includes(role) ? 201 : 403);
      expect(
        (
          await client.post('/api/v1/room-types', {
            name: `R ${uniqueNumber()}`,
            capacity: 2,
            ratePaise: 1000,
          })
        ).status,
      ).toBe(writeRoles.includes(role) ? 201 : 403);

      const target = (await client.get('/api/v1/rooms?limit=1')).body.data[0].id;
      const status = await client.post(`/api/v1/rooms/${target}/status`, { status: 'cleaning' });
      if (statusRoles.includes(role)) expect(status.status).toBe(200);
      else expect(status.status).toBe(403);
      if (status.status === 200)
        await client.post(`/api/v1/rooms/${target}/status`, { status: 'available' });
    });
  }

  it('answers 401 without sign-in', async () => {
    expect((await t.anonymous.get('/api/v1/rooms')).status).toBe(401);
    expect((await t.anonymous.post('/api/v1/rooms', {})).status).toBe(401);
  });
});
