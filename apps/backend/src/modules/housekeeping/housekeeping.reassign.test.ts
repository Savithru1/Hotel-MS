import type { StaffRole } from '@hospitality/constants';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { addStaff, lookup, type Lookup } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { eventBus, type DomainEvent } from '../../shared/events/event-bus';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { ServiceRequest } from '../service-requests/service-request.model';

useTestDatabase();

const t = buildTestApp();
let a: SeededProperty;
let ids: Lookup;
let desk: Client;
let housekeeper: Client;
let manager: Client;

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

beforeAll(async () => {
  [a] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  desk = await as(a, 'front_desk');
  housekeeper = await as(a, 'housekeeping');
  manager = await as(a, 'manager');
  ids = await lookup(desk);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A cleaning task already started by the seeded housekeeper. */
async function startedTask(room = '102'): Promise<string> {
  const created = await desk.post('/api/v1/housekeeping', {
    roomId: ids.rooms[room],
    type: 'room_cleaning',
  });
  expect(created.status).toBe(201);
  const id = created.body.data.id as string;
  expect((await housekeeper.post(`/api/v1/housekeeping/${id}/start`)).status).toBe(200);
  return id;
}

const stored = (id: string) =>
  runWithTenant(a.id, () => ServiceRequest.findOne({ _id: id }).lean());

describe('a manager reassigns a task that is already in progress', () => {
  it('hands it to another housekeeper, keeps it in progress and records the hand-over', async () => {
    const other = await addStaff(t, a, 'housekeeping');
    const id = await startedTask();

    const res = await manager.post(`/api/v1/housekeeping/${id}/assign`, {
      staffId: other.id.toHexString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('in_progress');
    expect(res.body.data.assignedTo.id).toBe(other.id.toHexString());

    const doc = await stored(id);
    expect(doc?.assignedTo?.toHexString()).toBe(other.id.toHexString());
    const last = doc?.history.at(-1);
    expect(last).toMatchObject({ from: 'in_progress', to: 'in_progress' });
    expect(last?.note).toMatch(/Reassigned to/);
    expect(last?.by).toMatchObject({ kind: 'staff', role: 'manager' });

    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'housekeeping.reassigned', 'target.id': id }).lean(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.summary).toMatchObject({ assignedTo: other.id.toHexString() });
  });

  it('moves the task: the old housekeeper can no longer finish it, the new one can', async () => {
    const other = await addStaff(t, a, 'housekeeping');
    const id = await startedTask('103');
    await manager.post(`/api/v1/housekeeping/${id}/assign`, { staffId: other.id.toHexString() });

    const refused = await housekeeper.post(`/api/v1/housekeeping/${id}/complete`, {});
    expect(refused.status).toBe(403);
    expect((await other.client.post(`/api/v1/housekeeping/${id}/complete`, {})).status).toBe(200);
  });

  it('works for a property admin too', async () => {
    const other = await addStaff(t, a, 'housekeeping');
    const id = await startedTask('104');
    const admin = await as(a, 'property_admin');
    const res = await admin.post(`/api/v1/housekeeping/${id}/assign`, {
      staffId: other.id.toHexString(),
    });
    expect(res.status).toBe(200);
  });

  it('is refused for housekeeping and front desk staff', async () => {
    const other = await addStaff(t, a, 'housekeeping');
    const id = await startedTask('105');
    for (const client of [housekeeper, desk]) {
      const res = await client.post(`/api/v1/housekeeping/${id}/assign`, {
        staffId: other.id.toHexString(),
      });
      expect(res.status).toBe(403);
    }
    expect((await stored(id))?.assignedTo?.toHexString()).toBe(
      a.staff.housekeeping?.id.toHexString(),
    );
  });

  it('refuses to hand it to the person who already has it', async () => {
    const id = await startedTask('201');
    const res = await manager.post(`/api/v1/housekeeping/${id}/assign`, {
      staffId: a.staff.housekeeping?.id.toHexString(),
    });
    expect(res.status).toBe(409);
  });

  it('still refuses to assign a completed or cancelled task', async () => {
    const other = await addStaff(t, a, 'housekeeping');
    const done = await startedTask('202');
    await housekeeper.post(`/api/v1/housekeeping/${done}/complete`, {});
    const cancelled = (
      await desk.post('/api/v1/housekeeping', { roomId: ids.rooms['203'], type: 'room_cleaning' })
    ).body.data.id as string;
    await desk.post(`/api/v1/housekeeping/${cancelled}/cancel`, { reason: 'Not needed' });

    for (const id of [done, cancelled]) {
      const res = await manager.post(`/api/v1/housekeeping/${id}/assign`, {
        staffId: other.id.toHexString(),
      });
      expect(res.status).toBe(409);
    }
  });

  it('gives exactly one of two managers the win when both reassign at the very same moment', async () => {
    const first = await addStaff(t, a, 'housekeeping');
    const second = await addStaff(t, a, 'housekeeping');
    const manager2 = await addStaff(t, a, 'manager');
    const id = await startedTask('204');

    // Hold both updates back until both requests have read the task and passed every check, so
    // they genuinely collide on the database instead of happening one after the other.
    const original = ServiceRequest.findOneAndUpdate.bind(ServiceRequest);
    let arrived = 0;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    vi.spyOn(ServiceRequest, 'findOneAndUpdate').mockImplementation(((...args: unknown[]) => {
      arrived += 1;
      if (arrived === 2) open();
      return {
        lean: async () => {
          await gate;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- forwarding the call
          return (original as any)(...args).lean();
        },
      };
    }) as never);

    const [r1, r2] = await Promise.all([
      manager.post(`/api/v1/housekeeping/${id}/assign`, { staffId: first.id.toHexString() }),
      manager2.client.post(`/api/v1/housekeeping/${id}/assign`, {
        staffId: second.id.toHexString(),
      }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);

    const doc = await stored(id);
    const winner = r1.status === 200 ? first.id : second.id;
    expect(doc?.assignedTo?.toHexString()).toBe(winner.toHexString());
    expect(doc?.history.filter((h) => h.note?.startsWith('Reassigned'))).toHaveLength(1);
  });
});

describe('housekeeping events say who the request is assigned to', () => {
  async function capture(act: () => Promise<unknown>): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];
    const off = eventBus.subscribe((event) => events.push(event));
    await act();
    off();
    return events.filter((event) => event.type === 'housekeeping.changed');
  }

  it('carries assignedTo for assign, reassign, escalate and create', async () => {
    const other = await addStaff(t, a, 'housekeeping');
    const created = (
      await desk.post('/api/v1/housekeeping', { roomId: ids.rooms['205'], type: 'room_cleaning' })
    ).body.data.id as string;

    const assigned = await capture(() =>
      manager.post(`/api/v1/housekeeping/${created}/assign`, { staffId: other.id.toHexString() }),
    );
    expect(assigned[0]?.data).toMatchObject({
      change: 'assigned',
      assignedTo: other.id.toHexString(),
    });

    const escalated = await capture(() =>
      housekeeper.post(`/api/v1/housekeeping/${created}/escalate`, { reason: 'Guest waiting' }),
    );
    expect(escalated[0]?.data).toMatchObject({
      change: 'escalated',
      assignedTo: other.id.toHexString(),
    });

    await other.client.post(`/api/v1/housekeeping/${created}/start`);
    const third = await addStaff(t, a, 'housekeeping');
    const reassigned = await capture(() =>
      manager.post(`/api/v1/housekeeping/${created}/assign`, { staffId: third.id.toHexString() }),
    );
    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]?.data).toMatchObject({
      change: 'reassigned',
      assignedTo: third.id.toHexString(),
    });

    const fresh = await capture(() =>
      desk.post('/api/v1/housekeeping', { roomId: ids.rooms['101'], type: 'room_cleaning' }),
    );
    expect(fresh[0]?.data).toMatchObject({ change: 'created', assignedTo: null });
  });
});
