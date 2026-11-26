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
import { ServiceRequest } from '../service-requests/service-request.model';

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
let housekeeper: Client;
let manager: Client;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  desk = await as(a, 'front_desk');
  housekeeper = await as(a, 'housekeeping');
  manager = await as(a, 'manager');
  ids = await lookup(desk);
  await checkInGuest(desk, ids, '101', 'Standard', '+917000000101');
});

const cleaning = (room: string, extra: Record<string, unknown> = {}) => ({
  roomId: ids.rooms[room],
  type: 'room_cleaning',
  ...extra,
});

async function newTask(room = '102', extra: Record<string, unknown> = {}) {
  const res = await desk.post('/api/v1/housekeeping', cleaning(room, extra));
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

describe('logging a request', () => {
  it('attaches the guest who is in the room and starts as New', async () => {
    const res = await desk.post('/api/v1/housekeeping', {
      roomId: ids.rooms['101'],
      type: 'towels',
      notes: 'Two extra towels',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      type: 'towels',
      roomNumber: '101',
      guestName: 'In House Guest',
      notes: 'Two extra towels',
      priority: 'normal',
      status: 'new',
      assignedTo: null,
      escalated: false,
      source: 'front_desk',
    });
    expect(res.body.data.bookingId).toBeTruthy();
  });

  it('refuses a guest request for a room with nobody in it, but allows cleaning an empty room', async () => {
    const refused = await desk.post('/api/v1/housekeeping', {
      roomId: ids.rooms['103'],
      type: 'towels',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('no_guest_in_room');
    const empty = await desk.post('/api/v1/housekeeping', cleaning('103'));
    expect(empty.status).toBe(201);
    expect(empty.body.data).toMatchObject({ guestName: null, bookingId: null });
  });

  it('records a housekeeper-created task as coming from housekeeping', async () => {
    const res = await housekeeper.post('/api/v1/housekeeping', cleaning('104'));
    expect(res.body.data.source).toBe('housekeeping');
  });

  it('rejects an unknown room, another property’s room and bad input', async () => {
    const bRoom = (await (await as(b, 'front_desk')).get('/api/v1/rooms?limit=1')).body.data[0].id;
    for (const roomId of [new Types.ObjectId().toHexString(), bRoom]) {
      const res = await desk.post('/api/v1/housekeeping', { roomId, type: 'room_cleaning' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('unknown_room');
    }
    for (const bad of [
      {},
      cleaning('102', { type: 'laundry' }),
      cleaning('102', { priority: 'whenever' }),
      cleaning('102', { notes: 'x'.repeat(501) }),
    ]) {
      expect((await desk.post('/api/v1/housekeeping', bad)).status).toBe(400);
    }
  });

  it('ignores status, assignment and property fields sent by the client', async () => {
    const res = await desk.post(
      '/api/v1/housekeeping',
      cleaning('105', {
        status: 'completed',
        assignedTo: a.staff.housekeeping?.id.toHexString(),
        propertyId: b.id.toHexString(),
        escalated: true,
        source: 'guest',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'new',
      assignedTo: null,
      escalated: false,
      source: 'front_desk',
    });
    expect(
      await runWithTenant(b.id, () => ServiceRequest.countDocuments({ _id: res.body.data.id })),
    ).toBe(0);
  });

  it('puts urgent requests first in the queue', async () => {
    await newTask('201');
    const urgent = await newTask('202', { priority: 'urgent' });
    const list = await housekeeper.get('/api/v1/housekeeping?open=true&limit=100');
    expect(list.body.data[0].id).toBe(urgent.id);
    expect(list.body.data[0].priority).toBe('urgent');
  });

  it('audits creation and announces it to housekeeping, the front desk and managers only', async () => {
    const events: DomainEvent[] = [];
    const off = eventBus.subscribe((event) => events.push(event));
    const task = await newTask('203');
    off();
    const created = events.filter((e) => e.type === 'housekeeping.changed');
    expect(created).toHaveLength(1);
    expect(created[0]?.audience).toEqual({ departments: ['housekeeping', 'front_desk'] });
    expect(created[0]?.data).toMatchObject({
      requestId: task.id,
      roomNumber: '203',
      status: 'new',
      change: 'created',
    });
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'housekeeping.created', 'target.id': task.id }).lean(),
    );
    expect(audits).toHaveLength(1);
  });
});

describe('working a task: New -> In Progress -> Completed', () => {
  it('goes through the whole workflow, recording each step in history', async () => {
    const task = await newTask('204');
    const started = await housekeeper.post(`/api/v1/housekeeping/${task.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.data.status).toBe('in_progress');
    expect(started.body.data.assignedTo).toMatchObject({
      id: a.staff.housekeeping?.id.toHexString(),
    });

    const done = await housekeeper.post(`/api/v1/housekeeping/${task.id}/complete`, {
      note: 'All done',
    });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('completed');
    expect(done.body.data.completedAt).not.toBeNull();

    const stored = await runWithTenant(a.id, () => ServiceRequest.findOne({ _id: task.id }).lean());
    expect(stored?.history.map((h) => h.to)).toEqual(['new', 'in_progress', 'completed']);
    expect(stored?.history[2]?.note).toBe('All done');
  });

  it.each([
    [
      'complete a task that has not started',
      async (id: string) => housekeeper.post(`/api/v1/housekeeping/${id}/complete`, {}),
    ],
    [
      'start a task twice',
      async (id: string) => {
        await housekeeper.post(`/api/v1/housekeeping/${id}/start`);
        return housekeeper.post(`/api/v1/housekeeping/${id}/start`);
      },
    ],
    [
      'start a completed task',
      async (id: string) => {
        await housekeeper.post(`/api/v1/housekeeping/${id}/start`);
        await housekeeper.post(`/api/v1/housekeeping/${id}/complete`, {});
        return housekeeper.post(`/api/v1/housekeeping/${id}/start`);
      },
    ],
    [
      'cancel a task that has started',
      async (id: string) => {
        await housekeeper.post(`/api/v1/housekeeping/${id}/start`);
        return desk.post(`/api/v1/housekeeping/${id}/cancel`, { reason: 'Too late' });
      },
    ],
    [
      'complete a cancelled task',
      async (id: string) => {
        await desk.post(`/api/v1/housekeeping/${id}/cancel`, { reason: 'Mistake' });
        return housekeeper.post(`/api/v1/housekeeping/${id}/complete`, {});
      },
    ],
  ])('refuses to %s with 409', async (_label, act) => {
    const task = await newTask('205');
    const res = await act(task.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('bad_transition');
  });

  it('cancels a task that has not started, with a reason, for the front desk only', async () => {
    const task = await newTask('102');
    expect(
      (await housekeeper.post(`/api/v1/housekeeping/${task.id}/cancel`, { reason: 'Not needed' }))
        .status,
    ).toBe(403);
    expect((await desk.post(`/api/v1/housekeeping/${task.id}/cancel`, {})).status).toBe(400);
    const res = await desk.post(`/api/v1/housekeeping/${task.id}/cancel`, {
      reason: 'Logged by mistake',
    });
    expect(res.body.data.status).toBe('cancelled');
  });

  it('gives exactly one of two housekeepers a task they both try to start at once', async () => {
    const second = await addStaff(t, a, 'housekeeping');
    for (let round = 0; round < 6; round++) {
      const task = await newTask('103');
      const [r1, r2] = await Promise.all([
        housekeeper.post(`/api/v1/housekeeping/${task.id}/start`),
        second.client.post(`/api/v1/housekeeping/${task.id}/start`),
      ]);
      // Exactly one wins. The other is told 409 (it lost the race) or 403 (it arrived just after
      // the winner had claimed the task), depending on timing.
      const statuses = [r1.status, r2.status];
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409 || status === 403)).toHaveLength(1);
      const winner =
        r1.status === 200 ? a.staff.housekeeping?.id.toHexString() : second.id.toHexString();
      const stored = await runWithTenant(a.id, () =>
        ServiceRequest.findOne({ _id: task.id }).lean(),
      );
      expect(stored?.assignedTo?.toHexString()).toBe(winner);
      expect(stored?.history.filter((h) => h.to === 'in_progress')).toHaveLength(1);
    }
  });
});

describe('assigning', () => {
  it('lets a manager hand an unstarted task to a housekeeper, who alone can then start it', async () => {
    const other = await addStaff(t, a, 'housekeeping');
    const task = await newTask('104');
    const assigned = await manager.post(`/api/v1/housekeeping/${task.id}/assign`, {
      staffId: other.id.toHexString(),
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.assignedTo.id).toBe(other.id.toHexString());
    expect(assigned.body.data.status).toBe('new');

    const refused = await housekeeper.post(`/api/v1/housekeeping/${task.id}/start`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('assigned_to_someone_else');
    expect((await other.client.post(`/api/v1/housekeeping/${task.id}/start`)).status).toBe(200);
  });

  it('lets a manager start it for them', async () => {
    const other = await addStaff(t, a, 'housekeeping');
    const task = await newTask('105');
    await manager.post(`/api/v1/housekeeping/${task.id}/assign`, {
      staffId: other.id.toHexString(),
    });
    const res = await manager.post(`/api/v1/housekeeping/${task.id}/start`);
    expect(res.status).toBe(200);
    expect(res.body.data.assignedTo.id).toBe(other.id.toHexString());
  });

  it('only assigns to active housekeeping staff of this property', async () => {
    const task = await newTask('201');
    const kitchen = a.staff.kitchen?.id.toHexString();
    expect(
      (await manager.post(`/api/v1/housekeeping/${task.id}/assign`, { staffId: kitchen })).body
        .error.code,
    ).toBe('not_assignable');
    const bStaff = b.staff.housekeeping?.id.toHexString();
    expect(
      (await manager.post(`/api/v1/housekeeping/${task.id}/assign`, { staffId: bStaff })).body.error
        .code,
    ).toBe('not_assignable');
    expect(
      (await manager.post(`/api/v1/housekeeping/${task.id}/assign`, { staffId: 'nope' })).status,
    ).toBe(400);
  });

  it('cannot be assigned by anyone but management, or after work began', async () => {
    const task = await newTask('202');
    const who = a.staff.housekeeping?.id.toHexString();
    for (const client of [desk, housekeeper]) {
      expect(
        (await client.post(`/api/v1/housekeeping/${task.id}/assign`, { staffId: who })).status,
      ).toBe(403);
    }
    await housekeeper.post(`/api/v1/housekeeping/${task.id}/start`);
    expect(
      (await manager.post(`/api/v1/housekeeping/${task.id}/assign`, { staffId: who })).status,
    ).toBe(409);
  });

  it('lets a housekeeper filter the queue to their own tasks', async () => {
    const mine = await newTask('203');
    await housekeeper.post(`/api/v1/housekeeping/${mine.id}/start`);
    const res = await housekeeper.get('/api/v1/housekeeping?mine=true&limit=100');
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const item of res.body.data)
      expect(item.assignedTo.id).toBe(a.staff.housekeeping?.id.toHexString());
  });
});

describe('the room follows the work (room-state chain)', () => {
  async function setRoom(number: string, status: string) {
    await runWithTenant(a.id, () => Room.updateOne({ _id: ids.rooms[number] }, { status }));
  }
  const roomStatus = async (number: string) =>
    (await runWithTenant(a.id, () => Room.findOne({ _id: ids.rooms[number] }).lean()))?.status;

  it('frees a room waiting to be cleaned when its cleaning is completed', async () => {
    await setRoom('204', 'cleaning');
    const task = await newTask('204');
    await housekeeper.post(`/api/v1/housekeeping/${task.id}/start`);
    expect(await roomStatus('204')).toBe('cleaning');

    const events: DomainEvent[] = [];
    const off = eventBus.subscribe((event) => events.push(event));
    await housekeeper.post(`/api/v1/housekeeping/${task.id}/complete`, {});
    off();
    expect(await roomStatus('204')).toBe('available');
    const roomEvent = events.find((e) => e.type === 'room.status_changed');
    expect(roomEvent?.data).toMatchObject({
      roomNumber: '204',
      status: 'available',
      previous: 'cleaning',
    });
  });

  it('leaves the room alone when it is not waiting to be cleaned', async () => {
    for (const status of ['available', 'maintenance', 'out_of_service']) {
      await setRoom('205', status);
      const task = await newTask('205');
      await housekeeper.post(`/api/v1/housekeeping/${task.id}/start`);
      await housekeeper.post(`/api/v1/housekeeping/${task.id}/complete`, {});
      expect(await roomStatus('205')).toBe(status);
    }
  });

  it('does not touch the room when a guest-request type (towels) is completed', async () => {
    const task = (
      await desk.post('/api/v1/housekeeping', { roomId: ids.rooms['101'], type: 'towels' })
    ).body.data;
    await housekeeper.post(`/api/v1/housekeeping/${task.id}/start`);
    await housekeeper.post(`/api/v1/housekeeping/${task.id}/complete`, {});
    expect(await roomStatus('101')).toBe('occupied');
  });

  it('completes normally and leaves a room alone that has since been occupied', async () => {
    await setRoom('102', 'cleaning');
    const task = await newTask('102');
    await housekeeper.post(`/api/v1/housekeeping/${task.id}/start`);
    // Make the room's status something "cleaning -> available" cannot be applied to by moving it
    // under the task's feet to a status the table does not allow towards available.
    await setRoom('102', 'occupied');
    const res = await housekeeper.post(`/api/v1/housekeeping/${task.id}/complete`, {});
    // Room is occupied now, so the chain does not apply and the task completes normally.
    expect(res.status).toBe(200);
    expect(await roomStatus('102')).toBe('occupied');
    await setRoom('102', 'available');
  });
});

describe('escalation', () => {
  it('flags an open task for the front desk and managers, and a front-desk user can clear it', async () => {
    const task = await newTask('201');
    const events: DomainEvent[] = [];
    const off = eventBus.subscribe((event) => events.push(event));
    const res = await housekeeper.post(`/api/v1/housekeeping/${task.id}/escalate`, {
      reason: 'Guest is waiting',
    });
    off();
    expect(res.body.data).toMatchObject({ escalated: true, escalationReason: 'Guest is waiting' });
    expect(events[0]?.data).toMatchObject({ escalated: true, change: 'escalated' });

    const flagged = await desk.get('/api/v1/housekeeping?escalated=true&limit=100');
    expect(flagged.body.data.map((x: { id: string }) => x.id)).toContain(task.id);
    expect((await housekeeper.post(`/api/v1/housekeeping/${task.id}/acknowledge`)).status).toBe(
      403,
    );
    const cleared = await desk.post(`/api/v1/housekeeping/${task.id}/acknowledge`);
    expect(cleared.body.data.escalated).toBe(false);
    expect((await desk.post(`/api/v1/housekeeping/${task.id}/acknowledge`)).body.error.code).toBe(
      'not_escalated',
    );
  });

  it('needs a reason and only works on open tasks', async () => {
    const task = await newTask('202');
    expect((await housekeeper.post(`/api/v1/housekeeping/${task.id}/escalate`, {})).status).toBe(
      400,
    );
    await housekeeper.post(`/api/v1/housekeeping/${task.id}/start`);
    await housekeeper.post(`/api/v1/housekeeping/${task.id}/complete`, {});
    const res = await housekeeper.post(`/api/v1/housekeeping/${task.id}/escalate`, {
      reason: 'Too late',
    });
    expect(res.status).toBe(409);
  });
});

describe('the dashboard', () => {
  it('counts by status, escalations and urgent open work', async () => {
    const res = await manager.get('/api/v1/housekeeping/summary');
    expect(res.status).toBe(200);
    const total = Object.values(res.body.data.byStatus as Record<string, number>).reduce(
      (x, y) => x + y,
      0,
    );
    const all = await manager.get('/api/v1/housekeeping?limit=100');
    expect(total).toBe(all.body.meta.total);
    expect(res.body.data.urgent).toBeGreaterThanOrEqual(1);
  });

  it('filters by status and pages the queue', async () => {
    const page = await manager.get('/api/v1/housekeeping?limit=2&page=2');
    expect(page.body.meta).toMatchObject({ page: 2, limit: 2 });
    const completed = await manager.get('/api/v1/housekeeping?status=completed&limit=100');
    for (const item of completed.body.data) expect(item.status).toBe('completed');
    expect((await manager.get('/api/v1/housekeeping?limit=500')).status).toBe(400);
  });
});

describe('who may do what, and property isolation', () => {
  const viewers: StaffRole[] = [
    'platform_admin',
    'property_admin',
    'manager',
    'front_desk',
    'housekeeping',
  ];
  for (const role of STAFF_ROLES) {
    it(`${role} ${viewers.includes(role) ? 'can' : 'cannot (403)'} see the housekeeping queue`, async () => {
      const client = await as(a, role);
      expect((await client.get('/api/v1/housekeeping')).status).toBe(
        viewers.includes(role) ? 200 : 403,
      );
      expect((await client.get('/api/v1/housekeeping/summary')).status).toBe(
        viewers.includes(role) ? 200 : 403,
      );
      const create = await client.post('/api/v1/housekeeping', {});
      expect(create.status).toBe(viewers.includes(role) ? 400 : 403);
    });
  }

  it('answers 401 without a sign-in', async () => {
    expect((await t.anonymous.get('/api/v1/housekeeping')).status).toBe(401);
  });

  it('keeps properties apart: no reading, starting, completing, cancelling or escalating across them', async () => {
    const task = await newTask('201');
    const bHousekeeper = await as(b, 'housekeeping');
    const bManager = await as(b, 'manager');
    expect((await bManager.get(`/api/v1/housekeeping/${task.id}`)).status).toBe(404);
    expect((await bHousekeeper.post(`/api/v1/housekeeping/${task.id}/start`)).status).toBe(404);
    expect((await bHousekeeper.post(`/api/v1/housekeeping/${task.id}/complete`, {})).status).toBe(
      404,
    );
    expect(
      (
        await (
          await as(b, 'front_desk')
        ).post(`/api/v1/housekeeping/${task.id}/cancel`, { reason: 'because' })
      ).status,
    ).toBe(404);
    expect(
      (await bHousekeeper.post(`/api/v1/housekeeping/${task.id}/escalate`, { reason: 'because' }))
        .status,
    ).toBe(404);
    const list = await bManager.get('/api/v1/housekeeping?limit=100');
    expect(list.body.data.map((x: { id: string }) => x.id)).not.toContain(task.id);
  });
});
