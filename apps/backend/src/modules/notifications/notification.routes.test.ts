import type { StaffRole } from '@hospitality/constants';
import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Notification } from './notification.model';

useTestDatabase();

const t = buildTestApp();
let a: SeededProperty;
let b: SeededProperty;
let counter = 0;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

const staffOf = (property: SeededProperty, role: StaffRole) => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return staff;
};
const as = (property: SeededProperty, role: StaffRole): Promise<Client> =>
  t.actAs(staffOf(property, role).id, property.id);

/** Plants a notification directly, so the route tests do not depend on the notifier. */
async function plant(property: SeededProperty, role: StaffRole, title = 'Hello'): Promise<string> {
  const created = await runWithTenant(property.id, () =>
    Notification.create({
      recipient: { kind: 'staff', id: staffOf(property, role).id },
      type: 'escalation',
      title,
      body: 'Body',
      link: { kind: 'housekeeping', id: new Types.ObjectId().toHexString() },
      dedupeKey: `route:${++counter}`,
    }),
  );
  return created._id.toHexString();
}

describe('authentication', () => {
  it.each([
    ['get', '/api/v1/notifications'],
    ['get', '/api/v1/notifications/unread-count'],
    ['post', '/api/v1/notifications/read-all'],
    ['post', `/api/v1/notifications/${new Types.ObjectId().toHexString()}/read`],
  ] as const)('answers 401 to %s %s with no token', async (method, path) => {
    const res = await t.anonymous[method](path);
    expect(res.status).toBe(401);
  });
});

describe('GET /notifications', () => {
  it('shows a front desk user their own items and never a manager’s', async () => {
    const managerItem = await plant(a, 'manager', 'manager only');
    const deskItem = await plant(a, 'front_desk', 'desk only');

    const desk = await as(a, 'front_desk');
    const res = await desk.get('/api/v1/notifications?limit=100');
    expect(res.status).toBe(200);
    const ids = (res.body.data as { id: string }[]).map((n) => n.id);
    expect(ids).toContain(deskItem);
    expect(ids).not.toContain(managerItem);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 100 });
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({ type: 'escalation', readAt: null, link: expect.any(Object) }),
    );
  });

  it('filters by unread and rejects a page size over 100', async () => {
    const id = await plant(a, 'housekeeping');
    const hk = await as(a, 'housekeeping');
    expect((await hk.post(`/api/v1/notifications/${id}/read`)).status).toBe(200);

    const unread = await hk.get('/api/v1/notifications?unread=true&limit=100');
    expect((unread.body.data as { id: string }[]).map((n) => n.id)).not.toContain(id);
    const read = await hk.get('/api/v1/notifications?unread=false');
    expect((read.body.data as { id: string }[]).map((n) => n.id)).toContain(id);

    expect((await hk.get('/api/v1/notifications?limit=101')).status).toBe(400);
  });

  it('never shows another property’s notifications, even for the same role', async () => {
    const theirs = await plant(b, 'manager', 'property B');
    const mine = await as(a, 'manager');
    const res = await mine.get('/api/v1/notifications?limit=100');
    expect((res.body.data as { id: string }[]).map((n) => n.id)).not.toContain(theirs);
  });
});

describe('GET /notifications/unread-count', () => {
  it('counts only my unread items', async () => {
    const desk = await as(a, 'kitchen');
    const before = (await desk.get('/api/v1/notifications/unread-count')).body.data
      .unread as number;
    await plant(a, 'kitchen');
    await plant(a, 'kitchen');
    await plant(a, 'manager');
    const after = (await desk.get('/api/v1/notifications/unread-count')).body.data.unread as number;
    expect(after).toBe(before + 2);
  });
});

describe('POST /notifications/:id/read', () => {
  it('marks my item read', async () => {
    const id = await plant(a, 'maintenance');
    const me = await as(a, 'maintenance');
    const res = await me.post(`/api/v1/notifications/${id}/read`);
    expect(res.status).toBe(200);
    expect(res.body.data.readAt).not.toBeNull();
  });

  it('answers 404 for another person’s item in my property and leaves it unread', async () => {
    const id = await plant(a, 'manager');
    const desk = await as(a, 'front_desk');
    expect((await desk.post(`/api/v1/notifications/${id}/read`)).status).toBe(404);
    const stored = await runWithTenant(a.id, () => Notification.findOne({ _id: id }).lean());
    expect(stored?.readAt).toBeNull();
  });

  it('answers 404 across properties, even for a manager', async () => {
    const id = await plant(b, 'manager');
    const mine = await as(a, 'manager');
    expect((await mine.post(`/api/v1/notifications/${id}/read`)).status).toBe(404);
    const stored = await runWithTenant(b.id, () => Notification.findOne({ _id: id }).lean());
    expect(stored?.readAt).toBeNull();
  });

  it('rejects an id that is not an object id', async () => {
    const me = await as(a, 'manager');
    expect((await me.post('/api/v1/notifications/not-an-id/read')).status).toBe(400);
  });
});

describe('POST /notifications/read-all', () => {
  it('reads all of mine and leaves everyone else’s alone', async () => {
    const mine = await plant(a, 'spa_recreation');
    const other = await plant(a, 'manager');
    const me = await as(a, 'spa_recreation');

    const res = await me.post('/api/v1/notifications/read-all');
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBeGreaterThanOrEqual(1);
    expect((await me.get('/api/v1/notifications/unread-count')).body.data.unread).toBe(0);
    const stored = await runWithTenant(a.id, () =>
      Notification.find({ _id: { $in: [mine, other] } }).lean(),
    );
    expect(stored.find((n) => n._id.toHexString() === other)?.readAt).toBeNull();
  });
});
