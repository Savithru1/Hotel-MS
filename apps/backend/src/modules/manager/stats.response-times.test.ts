import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { clientFor } from '../../../test/manager';
import { localDateTimeToUtc } from '../../shared/dates';
import { runWithTenant } from '../../shared/request-context';
import { FoodOrder } from '../food-orders/food-order.model';
import { MaintenanceIssue } from '../maintenance/maintenance.model';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { ServiceRequest } from '../service-requests/service-request.model';

useTestDatabase();

const TZ = 'Asia/Kolkata';
const D = '2026-04-05';
const t = buildTestApp();
let a: SeededProperty;
let b: SeededProperty;
let manager: Client;

const MINUTE = 60_000;
const created = (time: string): Date => localDateTimeToUtc(D, time, TZ);
const after = (from: Date, minutes: number): Date => new Date(from.getTime() + minutes * MINUTE);
const step = (from: string | null, to: string, at: Date) => ({ from, to, at });
const roomId = new Types.ObjectId();

function request(property: SeededProperty, plan: Record<string, unknown>) {
  return runWithTenant(property.id, () =>
    ServiceRequest.create({ type: 'room_cleaning', roomId, ...plan }),
  );
}

function issue(property: SeededProperty, plan: Record<string, unknown>) {
  return runWithTenant(property.id, () =>
    MaintenanceIssue.create({ category: 'plumbing', description: 'Leak', roomId, ...plan }),
  );
}

let code = 0;
function order(property: SeededProperty, plan: Record<string, unknown>) {
  return runWithTenant(property.id, () =>
    FoodOrder.create({
      code: `RT-${++code}`,
      roomId,
      roomNumber: '101',
      bookingId: new Types.ObjectId(),
      guestName: 'Guest',
      items: [
        {
          menuItemId: new Types.ObjectId(),
          name: 'Tea',
          quantity: 1,
          unitPricePaise: 5000,
          lineTotalPaise: 5000,
        },
      ],
      subtotalPaise: 5000,
      ...plan,
    }),
  );
}

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await clientFor(t, a, 'manager');

  // Housekeeping: first actions after 5 and 15 minutes. Completions after 20, 45 and 10 minutes.
  const h1 = created('10:00');
  await request(a, {
    status: 'completed',
    createdAt: h1,
    completedAt: after(h1, 20),
    history: [
      step(null, 'new', h1),
      step('new', 'in_progress', after(h1, 5)),
      step('in_progress', 'completed', after(h1, 20)),
    ],
  });
  const h2 = created('11:00');
  await request(a, {
    status: 'completed',
    createdAt: h2,
    completedAt: after(h2, 45),
    history: [
      step(null, 'new', h2),
      step('new', 'in_progress', after(h2, 15)),
      step('in_progress', 'completed', after(h2, 45)),
    ],
  });
  // Still waiting: counted as an item but has neither figure.
  await request(a, {
    status: 'new',
    createdAt: created('12:00'),
    history: [step(null, 'new', created('12:00'))],
  });
  // Finished without a recorded start: counts towards completion only.
  const h4 = created('13:00');
  await request(a, {
    status: 'completed',
    createdAt: h4,
    completedAt: after(h4, 10),
    history: [step(null, 'new', h4), step('new', 'completed', after(h4, 10))],
  });
  // Cancelled work, work outside the range and another property's work do not count.
  await request(a, { status: 'cancelled', createdAt: created('14:00'), history: [] });
  await request(a, {
    status: 'completed',
    createdAt: localDateTimeToUtc('2026-04-20', '10:00', TZ),
    completedAt: localDateTimeToUtc('2026-04-20', '23:00', TZ),
    history: [step('new', 'in_progress', localDateTimeToUtc('2026-04-20', '20:00', TZ))],
  });
  await request(b, {
    status: 'completed',
    createdAt: h1,
    completedAt: after(h1, 600),
    history: [step('new', 'in_progress', after(h1, 5))],
  });

  // Maintenance: first action is the first "assigned", or "in progress" when never assigned.
  const m1 = created('10:00');
  await issue(a, {
    status: 'resolved',
    createdAt: m1,
    resolvedAt: after(m1, 60),
    history: [
      step(null, 'new', m1),
      step('new', 'assigned', after(m1, 10)),
      step('assigned', 'in_progress', after(m1, 30)),
      step('in_progress', 'resolved', after(m1, 60)),
    ],
  });
  const m2 = created('11:00');
  await issue(a, {
    status: 'resolved',
    createdAt: m2,
    resolvedAt: after(m2, 80),
    history: [
      step(null, 'new', m2),
      step('new', 'in_progress', after(m2, 20)),
      step('in_progress', 'resolved', after(m2, 80)),
    ],
  });
  const m3 = created('12:00');
  await issue(a, {
    status: 'assigned',
    createdAt: m3,
    history: [step(null, 'new', m3), step('new', 'assigned', after(m3, 30))],
  });

  // Kitchen: preparing after 4, 8 and 7 minutes; delivered after 30 and 40 minutes.
  const f1 = created('10:00');
  await order(a, {
    status: 'delivered',
    createdAt: f1,
    preparingAt: after(f1, 4),
    deliveredAt: after(f1, 30),
  });
  const f2 = created('11:00');
  await order(a, {
    status: 'delivered',
    createdAt: f2,
    preparingAt: after(f2, 8),
    deliveredAt: after(f2, 40),
  });
  const f3 = created('12:00');
  await order(a, { status: 'preparing', createdAt: f3, preparingAt: after(f3, 7) });
  await order(a, { status: 'cancelled', createdAt: created('13:00') });
});

const times = (from: string, to: string, client: Client = manager) =>
  client.get(`/api/v1/manager/stats/response-times?from=${from}&to=${to}`);

describe('GET /manager/stats/response-times', () => {
  it('averages housekeeping first action and completion in whole seconds', async () => {
    const res = await times(D, D);
    expect(res.status).toBe(200);
    expect(res.body.data.from).toBe(D);
    expect(res.body.data.to).toBe(D);
    // First action: (5 + 15) / 2 = 10 minutes. Completion: (20 + 45 + 10) / 3 = 25 minutes.
    // The request still waiting counts as an item (n = 4) but has neither figure.
    expect(res.body.data.housekeeping).toEqual({
      n: 4,
      firstActionSeconds: 600,
      completionSeconds: 1500,
    });
  });

  it('uses the first assignment (else the start) for maintenance and the resolve time for completion', async () => {
    const res = await times(D, D);
    // First action: (10 + 20 + 30) / 3 = 20 minutes. Completion: (60 + 80) / 2 = 70 minutes.
    expect(res.body.data.maintenance).toEqual({
      n: 3,
      firstActionSeconds: 1200,
      completionSeconds: 4200,
    });
  });

  it('uses the preparing and delivered times for the kitchen and leaves out cancelled orders', async () => {
    const res = await times(D, D);
    // Preparing: (4 + 8 + 7) / 3 minutes = 380 seconds. Delivered: (30 + 40) / 2 = 35 minutes.
    expect(res.body.data.kitchen).toEqual({
      n: 3,
      firstActionSeconds: 380,
      completionSeconds: 2100,
    });
  });

  it('gives null, never 0, when a department has no data', async () => {
    const empty = await times('2026-05-01', '2026-05-03');
    const none = { n: 0, firstActionSeconds: null, completionSeconds: null };
    expect(empty.body.data).toMatchObject({ housekeeping: none, maintenance: none, kitchen: none });

    // Property B has one housekeeping request that was started after 5 minutes and finished after 10 hours.
    const managerB = await clientFor(t, b, 'manager');
    const other = await times(D, D, managerB);
    expect(other.body.data.housekeeping).toEqual({
      n: 1,
      firstActionSeconds: 300,
      completionSeconds: 36_000,
    });
    expect(other.body.data.maintenance).toEqual(none);
    expect(other.body.data.kitchen).toEqual(none);
  });

  it('counts items by the property-local day they were created', async () => {
    // 00:30 local on the 6th is still the 5th in UTC. It belongs to the 6th.
    const late = localDateTimeToUtc('2026-04-06', '00:30', TZ);
    await request(a, {
      status: 'in_progress',
      createdAt: late,
      history: [step('new', 'in_progress', after(late, 2))],
    });
    const next = await times('2026-04-06', '2026-04-06');
    expect(next.body.data.housekeeping).toEqual({
      n: 1,
      firstActionSeconds: 120,
      completionSeconds: null,
    });
    expect((await times(D, D)).body.data.housekeeping.n).toBe(4);
  });

  it('refuses a backwards range and one over 92 days', async () => {
    expect((await times('2026-04-06', D)).status).toBe(400);
    expect((await times('2026-01-01', '2026-04-03')).status).toBe(400);
  });
});
