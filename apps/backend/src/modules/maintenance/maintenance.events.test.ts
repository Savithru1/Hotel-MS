import type { StaffRole } from '@hospitality/constants';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { lookup, type Lookup } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { eventBus, type DomainEvent } from '../../shared/events/event-bus';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';

useTestDatabase();

const t = buildTestApp();
let a: SeededProperty;
let ids: Lookup;
let manager: Client;
let housekeeper: Client;

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

beforeAll(async () => {
  [a] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await as(a, 'manager');
  housekeeper = await as(a, 'housekeeping');
  ids = await lookup(manager);
});

async function capture(act: () => Promise<unknown>): Promise<DomainEvent[]> {
  const events: DomainEvent[] = [];
  const off = eventBus.subscribe((event) => events.push(event));
  await act();
  off();
  return events.filter((event) => event.type === 'maintenance.changed');
}

describe('maintenance events say who the issue is assigned to', () => {
  it('carries assignedTo on create, assign, reassign and escalate', async () => {
    const technician = a.staff.maintenance?.id.toHexString();
    let issueId = '';
    const created = await capture(async () => {
      const res = await housekeeper.post('/api/v1/maintenance', {
        roomId: ids.rooms['102'],
        category: 'plumbing',
        description: 'Tap leaks',
      });
      issueId = res.body.data.id as string;
    });
    expect(created[0]?.data).toMatchObject({ change: 'created', assignedTo: null });

    const assigned = await capture(() =>
      manager.post(`/api/v1/maintenance/${issueId}/assign`, { staffId: technician }),
    );
    expect(assigned[0]?.data).toMatchObject({ change: 'assigned', assignedTo: technician });

    const escalated = await capture(() =>
      manager.post(`/api/v1/maintenance/${issueId}/escalate`, { reason: 'Water on the floor' }),
    );
    expect(escalated[0]?.data).toMatchObject({ change: 'escalated', assignedTo: technician });
  });
});
