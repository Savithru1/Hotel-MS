import { STAFF_ROLES, type StaffRole } from '@hospitality/constants';
import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { addStaff, checkInGuest, lookup, type Lookup } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { eventBus, type DomainEvent } from '../../shared/events/event-bus';
import { runWithTenant } from '../../shared/request-context';
import { Room } from '../rooms/room.model';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { MaintenanceIssue } from './maintenance.model';

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

let desk: Client;
let technician: Client;
let manager: Client;
let housekeeper: Client;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  desk = await as(a, 'front_desk');
  technician = await as(a, 'maintenance');
  manager = await as(a, 'manager');
  housekeeper = await as(a, 'housekeeping');
  ids = await lookup(desk);
  await checkInGuest(desk, ids, '101', 'Standard', '+917000000101');
});

const technicianId = (): string => a.staff.maintenance?.id.toHexString() ?? '';
const roomStatus = async (number: string) =>
  (await runWithTenant(a.id, () => Room.findOne({ _id: ids.rooms[number] }).lean()))?.status;

const issue = (room: string, extra: Record<string, unknown> = {}) => ({
  roomId: ids.rooms[room],
  category: 'air_conditioning',
  description: 'AC is not cooling',
  ...extra,
});

async function newIssue(room = '102', extra: Record<string, unknown> = {}, client = desk) {
  const res = await client.post('/api/v1/maintenance', issue(room, extra));
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

describe('reporting an issue', () => {
  it('creates a New issue with priority, room and the guest booking if one is in the room', async () => {
    const res = await desk.post('/api/v1/maintenance', issue('101', { priority: 'high' }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      category: 'air_conditioning',
      description: 'AC is not cooling',
      priority: 'high',
      roomNumber: '101',
      status: 'new',
      assignedTo: null,
      takesRoomOutOfService: false,
      escalated: false,
    });
    expect(res.body.data.bookingId).toBeTruthy();
    expect(res.body.data.reportedBy).toBe(a.staff.front_desk?.id.toHexString());
  });

  it('defaults to medium priority', async () => {
    expect((await newIssue('102')) && true).toBe(true);
    const list = await manager.get('/api/v1/maintenance?limit=100');
    expect(list.body.data.some((i: { priority: string }) => i.priority === 'medium')).toBe(true);
  });

  it.each([
    ['no description', { description: ' ' }],
    ['a short description', { description: 'x' }],
    ['an unknown category', { category: 'ghosts' }],
    ['an unknown priority', { priority: 'someday' }],
    ['a huge description', { description: 'x'.repeat(501) }],
    ['text for the room-out-of-service flag', { takeRoomOutOfService: 'yes' }],
  ])('rejects %s', async (_label, bad) => {
    expect((await desk.post('/api/v1/maintenance', issue('102', bad))).status).toBe(400);
  });

  it('rejects an unknown room and another property’s room', async () => {
    const bRoom = (await (await as(b, 'front_desk')).get('/api/v1/rooms?limit=1')).body.data[0].id;
    for (const roomId of [new Types.ObjectId().toHexString(), bRoom]) {
      const res = await desk.post('/api/v1/maintenance', issue('102', { roomId }));
      expect(res.body.error.code).toBe('unknown_room');
    }
  });

  it('ignores status, assignment and property fields sent by the client', async () => {
    const res = await desk.post(
      '/api/v1/maintenance',
      issue('102', {
        status: 'resolved',
        assignedTo: technicianId(),
        propertyId: b.id.toHexString(),
        escalated: true,
      }),
    );
    expect(res.body.data).toMatchObject({ status: 'new', assignedTo: null, escalated: false });
    expect(await runWithTenant(b.id, () => MaintenanceIssue.countDocuments())).toBe(0);
  });

  it('lets housekeeping report a problem they find, without being able to see the queue', async () => {
    const res = await housekeeper.post(
      '/api/v1/maintenance',
      issue('103', { category: 'plumbing', description: 'Tap leaks' }),
    );
    expect(res.status).toBe(201);
    expect((await housekeeper.get('/api/v1/maintenance')).status).toBe(403);
    expect((await housekeeper.get(`/api/v1/maintenance/${res.body.data.id}`)).status).toBe(403);
  });

  it('audits it and announces it to maintenance, front desk and managers, never housekeeping', async () => {
    const events: DomainEvent[] = [];
    const off = eventBus.subscribe((event) => events.push(event));
    const created = await newIssue('104');
    off();
    const event = events.find((e) => e.type === 'maintenance.changed');
    expect(event?.audience).toEqual({ departments: ['maintenance', 'front_desk'] });
    expect(event?.audience.departments).not.toContain('housekeeping');
    expect(event?.data).toMatchObject({
      issueId: created.id,
      status: 'new',
      change: 'created',
      priority: 'medium',
    });
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'maintenance.created', 'target.id': created.id }).lean(),
    );
    expect(audits).toHaveLength(1);
  });
});

describe('taking a room out of service (room-state chain)', () => {
  it('moves an available room to maintenance together with the issue, and announces it', async () => {
    const events: DomainEvent[] = [];
    const off = eventBus.subscribe((event) => events.push(event));
    const res = await desk.post(
      '/api/v1/maintenance',
      issue('201', { takeRoomOutOfService: true }),
    );
    off();
    expect(res.status).toBe(201);
    expect(res.body.data.takesRoomOutOfService).toBe(true);
    expect(await roomStatus('201')).toBe('maintenance');
    const roomEvent = events.find((e) => e.type === 'room.status_changed');
    expect(roomEvent?.data).toMatchObject({
      roomNumber: '201',
      status: 'maintenance',
      previous: 'available',
    });
  });

  it('refuses while a guest is in the room, and creates nothing', async () => {
    const before = await runWithTenant(a.id, () => MaintenanceIssue.countDocuments());
    const res = await desk.post(
      '/api/v1/maintenance',
      issue('101', { takeRoomOutOfService: true }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('room_occupied');
    expect(await runWithTenant(a.id, () => MaintenanceIssue.countDocuments())).toBe(before);
    expect(await roomStatus('101')).toBe('occupied');
  });

  it('can take a room that is waiting to be cleaned out of service, and a second issue changes nothing more', async () => {
    await runWithTenant(a.id, () =>
      Room.updateOne({ _id: ids.rooms['202'] }, { status: 'cleaning' }),
    );
    await desk.post('/api/v1/maintenance', issue('202', { takeRoomOutOfService: true }));
    expect(await roomStatus('202')).toBe('maintenance');
    expect(
      (await desk.post('/api/v1/maintenance', issue('202', { takeRoomOutOfService: true }))).status,
    ).toBe(201);
    expect(await roomStatus('202')).toBe('maintenance');
  });

  it('releases the room only when the last issue holding it is resolved', async () => {
    const first = await newIssue('203', { takeRoomOutOfService: true });
    const second = await newIssue('203', { takeRoomOutOfService: true });
    expect(await roomStatus('203')).toBe('maintenance');

    for (const one of [first, second]) {
      await manager.post(`/api/v1/maintenance/${one.id}/assign`, { staffId: technicianId() });
      await technician.post(`/api/v1/maintenance/${one.id}/start`);
    }
    const events: DomainEvent[] = [];
    const off = eventBus.subscribe((event) => events.push(event));
    await technician.post(`/api/v1/maintenance/${first.id}/resolve`, {
      resolutionNote: 'Replaced the thermostat',
    });
    expect(await roomStatus('203')).toBe('maintenance');
    expect(events.some((e) => e.type === 'room.status_changed')).toBe(false);

    await technician.post(`/api/v1/maintenance/${second.id}/resolve`, {
      resolutionNote: 'Recharged the gas',
    });
    off();
    expect(await roomStatus('203')).toBe('available');
    expect(events.find((e) => e.type === 'room.status_changed')?.data).toMatchObject({
      roomNumber: '203',
      status: 'available',
      previous: 'maintenance',
    });
  });

  it('leaves the room alone when an issue that did not take it out of service is resolved', async () => {
    await runWithTenant(a.id, () =>
      Room.updateOne({ _id: ids.rooms['204'] }, { status: 'cleaning' }),
    );
    const created = await newIssue('204');
    await manager.post(`/api/v1/maintenance/${created.id}/assign`, { staffId: technicianId() });
    await technician.post(`/api/v1/maintenance/${created.id}/start`);
    await technician.post(`/api/v1/maintenance/${created.id}/resolve`, {
      resolutionNote: 'Fixed the TV remote',
    });
    expect(await roomStatus('204')).toBe('cleaning');
  });

  it('does not free a room that was taken out of service by hand since', async () => {
    const created = await newIssue('205', { takeRoomOutOfService: true });
    await runWithTenant(a.id, () =>
      Room.updateOne({ _id: ids.rooms['205'] }, { status: 'out_of_service' }),
    );
    await manager.post(`/api/v1/maintenance/${created.id}/assign`, { staffId: technicianId() });
    await technician.post(`/api/v1/maintenance/${created.id}/start`);
    await technician.post(`/api/v1/maintenance/${created.id}/resolve`, { resolutionNote: 'Done' });
    expect(await roomStatus('205')).toBe('out_of_service');
  });
});

describe('workflow: New -> Assigned -> In Progress -> Resolved', () => {
  it('runs the whole way, with history and a resolution note', async () => {
    const created = await newIssue('102');
    const assigned = await manager.post(`/api/v1/maintenance/${created.id}/assign`, {
      staffId: technicianId(),
    });
    expect(assigned.body.data).toMatchObject({
      status: 'assigned',
      assignedTo: { id: technicianId() },
    });
    const started = await technician.post(`/api/v1/maintenance/${created.id}/start`);
    expect(started.body.data.status).toBe('in_progress');
    const resolved = await technician.post(`/api/v1/maintenance/${created.id}/resolve`, {
      resolutionNote: 'Cleaned the filter',
    });
    expect(resolved.body.data).toMatchObject({
      status: 'resolved',
      resolutionNote: 'Cleaned the filter',
    });
    expect(resolved.body.data.resolvedAt).not.toBeNull();

    const stored = await runWithTenant(a.id, () =>
      MaintenanceIssue.findOne({ _id: created.id }).lean(),
    );
    expect(stored?.history.map((h) => h.to)).toEqual([
      'new',
      'assigned',
      'in_progress',
      'resolved',
    ]);
  });

  it.each([
    [
      'start an issue nobody has been assigned',
      async (id: string) => manager.post(`/api/v1/maintenance/${id}/start`),
    ],
    [
      'resolve an issue that is only assigned',
      async (id: string) => {
        await manager.post(`/api/v1/maintenance/${id}/assign`, { staffId: technicianId() });
        return technician.post(`/api/v1/maintenance/${id}/resolve`, {
          resolutionNote: 'Skipped the work',
        });
      },
    ],
    [
      'resolve an issue nobody has been assigned',
      async (id: string) =>
        manager.post(`/api/v1/maintenance/${id}/resolve`, { resolutionNote: 'Skipped everything' }),
    ],
    [
      'start a resolved issue',
      async (id: string) => {
        await manager.post(`/api/v1/maintenance/${id}/assign`, { staffId: technicianId() });
        await technician.post(`/api/v1/maintenance/${id}/start`);
        await technician.post(`/api/v1/maintenance/${id}/resolve`, { resolutionNote: 'All fixed' });
        return technician.post(`/api/v1/maintenance/${id}/start`);
      },
    ],
    [
      'assign a resolved issue',
      async (id: string) => {
        await manager.post(`/api/v1/maintenance/${id}/assign`, { staffId: technicianId() });
        await technician.post(`/api/v1/maintenance/${id}/start`);
        await technician.post(`/api/v1/maintenance/${id}/resolve`, { resolutionNote: 'All fixed' });
        return manager.post(`/api/v1/maintenance/${id}/assign`, { staffId: technicianId() });
      },
    ],
    [
      'start an issue twice',
      async (id: string) => {
        await manager.post(`/api/v1/maintenance/${id}/assign`, { staffId: technicianId() });
        await technician.post(`/api/v1/maintenance/${id}/start`);
        return technician.post(`/api/v1/maintenance/${id}/start`);
      },
    ],
  ])('refuses to %s with 409', async (_label, act) => {
    const created = await newIssue('103');
    const res = await act(created.id);
    expect(res.status).toBe(409);
    expect(['bad_transition', 'conflict']).toContain(res.body.error.code);
  });

  it('needs a note saying what was done', async () => {
    const created = await newIssue('104');
    await manager.post(`/api/v1/maintenance/${created.id}/assign`, { staffId: technicianId() });
    await technician.post(`/api/v1/maintenance/${created.id}/start`);
    expect((await technician.post(`/api/v1/maintenance/${created.id}/resolve`, {})).status).toBe(
      400,
    );
    expect(
      (await technician.post(`/api/v1/maintenance/${created.id}/resolve`, { resolutionNote: 'ok' }))
        .status,
    ).toBe(400);
  });
});

describe('assigning and reassigning', () => {
  it('lets a manager hand an issue to someone else, even mid-work, which puts it back to Assigned', async () => {
    const other = await addStaff(t, a, 'maintenance');
    const created = await newIssue('105');
    await manager.post(`/api/v1/maintenance/${created.id}/assign`, { staffId: technicianId() });
    await technician.post(`/api/v1/maintenance/${created.id}/start`);
    const res = await manager.post(`/api/v1/maintenance/${created.id}/assign`, {
      staffId: other.id.toHexString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'assigned',
      assignedTo: { id: other.id.toHexString() },
    });
    // The first technician is out of it.
    expect((await technician.post(`/api/v1/maintenance/${created.id}/start`)).status).toBe(403);
    expect((await other.client.post(`/api/v1/maintenance/${created.id}/start`)).status).toBe(200);
  });

  it('lets a technician take an unassigned issue for themselves, and nothing else', async () => {
    const created = await newIssue('105');
    const other = await addStaff(t, a, 'maintenance');
    const forOther = await technician.post(`/api/v1/maintenance/${created.id}/assign`, {
      staffId: other.id.toHexString(),
    });
    expect(forOther.status).toBe(403);
    expect(
      (
        await technician.post(`/api/v1/maintenance/${created.id}/assign`, {
          staffId: technicianId(),
        })
      ).status,
    ).toBe(200);
    // Already assigned now, so another technician cannot take it over.
    const stolen = await other.client.post(`/api/v1/maintenance/${created.id}/assign`, {
      staffId: other.id.toHexString(),
    });
    expect(stolen.status).toBe(403);
  });

  it('keeps one technician from starting or resolving another’s issue', async () => {
    const other = await addStaff(t, a, 'maintenance');
    const created = await newIssue('105');
    await manager.post(`/api/v1/maintenance/${created.id}/assign`, { staffId: technicianId() });
    const start = await other.client.post(`/api/v1/maintenance/${created.id}/start`);
    expect(start.status).toBe(403);
    expect(start.body.error.code).toBe('not_your_issue');
    await technician.post(`/api/v1/maintenance/${created.id}/start`);
    expect(
      (
        await other.client.post(`/api/v1/maintenance/${created.id}/resolve`, {
          resolutionNote: 'Not mine',
        })
      ).status,
    ).toBe(403);
  });

  it('only assigns active maintenance staff of this property', async () => {
    const created = await newIssue('105');
    for (const staffId of [
      a.staff.housekeeping?.id.toHexString(),
      b.staff.maintenance?.id.toHexString(),
    ]) {
      expect(
        (await manager.post(`/api/v1/maintenance/${created.id}/assign`, { staffId })).body.error
          .code,
      ).toBe('not_assignable');
    }
  });

  it('gives exactly one winner when two managers assign different technicians at once', async () => {
    const other = await addStaff(t, a, 'maintenance');
    const manager2 = await addStaff(t, a, 'manager');
    for (let round = 0; round < 6; round++) {
      const created = await newIssue('105');
      const [r1, r2] = await Promise.all([
        manager.post(`/api/v1/maintenance/${created.id}/assign`, { staffId: technicianId() }),
        manager2.client.post(`/api/v1/maintenance/${created.id}/assign`, {
          staffId: other.id.toHexString(),
        }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const stored = await runWithTenant(a.id, () =>
        MaintenanceIssue.findOne({ _id: created.id }).lean(),
      );
      expect(stored?.history.filter((h) => h.to === 'assigned')).toHaveLength(1);
      const winner = r1.status === 200 ? technicianId() : other.id.toHexString();
      expect(stored?.assignedTo?.toHexString()).toBe(winner);
    }
  });

  it('lists a technician’s own issues with the mine filter', async () => {
    const created = await newIssue('105');
    await manager.post(`/api/v1/maintenance/${created.id}/assign`, { staffId: technicianId() });
    const res = await technician.get('/api/v1/maintenance?mine=true&limit=100');
    expect(res.body.data.map((i: { id: string }) => i.id)).toContain(created.id);
    for (const item of res.body.data) expect(item.assignedTo.id).toBe(technicianId());
  });
});

describe('escalation and the dashboard', () => {
  it('flags an open issue, lets the front desk clear it, and clears it on resolution', async () => {
    const created = await newIssue('102');
    const res = await technician.post(`/api/v1/maintenance/${created.id}/escalate`, {
      reason: 'Guest complaining',
    });
    expect(res.body.data).toMatchObject({ escalated: true, escalationReason: 'Guest complaining' });
    expect((await technician.post(`/api/v1/maintenance/${created.id}/acknowledge`)).status).toBe(
      403,
    );
    expect(
      (await desk.post(`/api/v1/maintenance/${created.id}/acknowledge`)).body.data.escalated,
    ).toBe(false);

    await technician.post(`/api/v1/maintenance/${created.id}/escalate`, { reason: 'Still broken' });
    await manager.post(`/api/v1/maintenance/${created.id}/assign`, { staffId: technicianId() });
    await technician.post(`/api/v1/maintenance/${created.id}/start`);
    const resolved = await technician.post(`/api/v1/maintenance/${created.id}/resolve`, {
      resolutionNote: 'Sorted out',
    });
    expect(resolved.body.data.escalated).toBe(false);
    expect(
      (await technician.post(`/api/v1/maintenance/${created.id}/escalate`, { reason: 'Too late' }))
        .status,
    ).toBe(409);
  });

  it('puts urgent issues first and summarises the queue', async () => {
    const urgent = await newIssue('104', { priority: 'urgent' });
    const list = await manager.get('/api/v1/maintenance?open=true&limit=100');
    expect(list.body.data[0].id).toBe(urgent.id);
    const summary = await manager.get('/api/v1/maintenance/summary');
    const total = Object.values(summary.body.data.byStatus as Record<string, number>).reduce(
      (x, y) => x + y,
      0,
    );
    expect(total).toBe((await manager.get('/api/v1/maintenance?limit=100')).body.meta.total);
    expect(summary.body.data.urgent).toBeGreaterThanOrEqual(1);
  });

  it('filters by status, priority and room, pages, and caps the page size', async () => {
    const resolved = await manager.get('/api/v1/maintenance?status=resolved&limit=100');
    for (const item of resolved.body.data) expect(item.status).toBe('resolved');
    const high = await manager.get('/api/v1/maintenance?priority=high&limit=100');
    for (const item of high.body.data) expect(item.priority).toBe('high');
    const room = await manager.get(`/api/v1/maintenance?roomId=${ids.rooms['101']}`);
    for (const item of room.body.data) expect(item.roomNumber).toBe('101');
    expect((await manager.get('/api/v1/maintenance?limit=1&page=2')).body.meta).toMatchObject({
      page: 2,
      limit: 1,
    });
    expect((await manager.get('/api/v1/maintenance?limit=500')).status).toBe(400);
  });
});

describe('who may do what, and property isolation', () => {
  const viewers: StaffRole[] = [
    'platform_admin',
    'property_admin',
    'manager',
    'front_desk',
    'maintenance',
  ];
  const reporters: StaffRole[] = [...viewers, 'housekeeping'];
  for (const role of STAFF_ROLES) {
    it(`${role}: view ${viewers.includes(role) ? 'yes' : 'no'}, report ${reporters.includes(role) ? 'yes' : 'no'}`, async () => {
      const client = await as(a, role);
      expect((await client.get('/api/v1/maintenance')).status).toBe(
        viewers.includes(role) ? 200 : 403,
      );
      expect((await client.get('/api/v1/maintenance/summary')).status).toBe(
        viewers.includes(role) ? 200 : 403,
      );
      expect((await client.post('/api/v1/maintenance', {})).status).toBe(
        reporters.includes(role) ? 400 : 403,
      );
      const someId = new Types.ObjectId().toHexString();
      const canWork = ['platform_admin', 'property_admin', 'manager', 'maintenance'].includes(role);
      expect((await client.post(`/api/v1/maintenance/${someId}/start`)).status).toBe(
        canWork ? 404 : 403,
      );
    });
  }

  it('answers 401 without a sign-in', async () => {
    expect((await t.anonymous.get('/api/v1/maintenance')).status).toBe(401);
  });

  it('keeps properties apart', async () => {
    const created = await newIssue('102');
    const bManager = await as(b, 'manager');
    const bTech = await as(b, 'maintenance');
    expect((await bManager.get(`/api/v1/maintenance/${created.id}`)).status).toBe(404);
    expect(
      (
        await bManager.post(`/api/v1/maintenance/${created.id}/assign`, {
          staffId: b.staff.maintenance?.id.toHexString(),
        })
      ).status,
    ).toBe(404);
    expect((await bTech.post(`/api/v1/maintenance/${created.id}/start`)).status).toBe(404);
    expect(
      (await bTech.post(`/api/v1/maintenance/${created.id}/escalate`, { reason: 'because' }))
        .status,
    ).toBe(404);
    expect((await bManager.get('/api/v1/maintenance?limit=100')).body.data).toHaveLength(0);
  });
});
