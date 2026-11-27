import type { StaffRole } from '@hospitality/constants';
import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { day, today } from '../../../test/fixtures';
import { buildTestApp } from '../../../test/http';
import { clientFor, line, plantBill, plantBooking, roomIdsOf } from '../../../test/manager';
import { recordAudit } from '../../shared/audit/audit';
import { runWithPrincipal } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';

useTestDatabase();

const t = buildTestApp();
let a: SeededProperty;
let b: SeededProperty;

const ROUTES = [
  '/api/v1/manager/overview',
  '/api/v1/manager/stats/occupancy',
  '/api/v1/manager/stats/revenue',
  '/api/v1/manager/stats/response-times',
  '/api/v1/audit-logs',
] as const;

const OUTSIDERS: StaffRole[] = [
  'front_desk',
  'kitchen',
  'housekeeping',
  'maintenance',
  'spa_recreation',
];
const MANAGERS: StaffRole[] = ['property_admin', 'manager'];

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

describe('who may read the manager routes', () => {
  it.each(ROUTES)('answers 401 to %s with no token', async (path) => {
    expect((await t.anonymous.get(path)).status).toBe(401);
  });

  it.each(ROUTES)('answers 401 to %s with a forged token', async (path) => {
    expect((await t.withToken('not.a.token').get(path)).status).toBe(401);
  });

  for (const role of OUTSIDERS) {
    it.each(ROUTES)(`answers 403 to ${role} on %s`, async (path) => {
      const res = await (await clientFor(t, a, role)).get(path);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  }

  for (const role of MANAGERS) {
    it.each(ROUTES)(`lets ${role} read %s`, async (path) => {
      const res = await (await clientFor(t, a, role)).get(path);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  }

  it('refuses outsiders before validating, so nothing is learned from the errors', async () => {
    const desk = await clientFor(t, a, 'front_desk');
    expect((await desk.get('/api/v1/manager/stats/revenue?from=nope')).status).toBe(403);
    expect((await desk.get('/api/v1/audit-logs?limit=9999')).status).toBe(403);
  });
});

describe('a manager sees only their own property', () => {
  it('shows nothing of property B in property A, and the reverse', async () => {
    const D = day(5);
    const roomsB = await roomIdsOf(b);
    await plantBooking(b, {
      status: 'confirmed',
      roomId: roomsB[0]!,
      checkInDate: D,
      checkOutDate: day(6),
    });
    await plantBill(b, new Types.ObjectId(), [
      line({
        lineId: 'b-1',
        category: 'room',
        serviceDate: today(),
        taxablePaise: 123_400,
        ratePercent: 5,
        taxPaise: 6_170,
      }),
    ]);
    await runWithPrincipal({ kind: 'staff', id: 'someone-in-b', role: 'manager' }, b.id, () =>
      recordAudit({ action: 'only.b', target: { type: 'thing', id: 'b-thing' } }),
    );

    const managerA = await clientFor(t, a, 'manager');
    const managerB = await clientFor(t, b, 'manager');

    const occupancyA = await managerA.get(`/api/v1/manager/stats/occupancy?from=${D}&to=${D}`);
    expect(occupancyA.body.data.days[0].occupied).toBe(0);
    const occupancyB = await managerB.get(`/api/v1/manager/stats/occupancy?from=${D}&to=${D}`);
    expect(occupancyB.body.data.days[0].occupied).toBe(1);

    const revenueA = await managerA.get(
      `/api/v1/manager/stats/revenue?from=${today()}&to=${today()}`,
    );
    expect(revenueA.body.data.totals.total.totalPaise).toBe(0);
    const revenueB = await managerB.get(
      `/api/v1/manager/stats/revenue?from=${today()}&to=${today()}`,
    );
    expect(revenueB.body.data.totals.total).toEqual({
      taxablePaise: 123_400,
      taxPaise: 6_170,
      totalPaise: 129_570,
    });

    const auditA = await managerA.get('/api/v1/audit-logs?action=only.b');
    expect(auditA.body.meta.total).toBe(0);
    const auditB = await managerB.get('/api/v1/audit-logs?action=only.b');
    expect(auditB.body.meta.total).toBe(1);
  });

  it('ignores a propertyId sent in the query', async () => {
    const managerA = await clientFor(t, a, 'manager');
    const res = await managerA.get(`/api/v1/manager/overview?propertyId=${b.id.toHexString()}`);
    expect(res.status).toBe(200);
    const own = await managerA.get('/api/v1/manager/overview');
    expect(res.body.data).toEqual(own.body.data);
  });
});
