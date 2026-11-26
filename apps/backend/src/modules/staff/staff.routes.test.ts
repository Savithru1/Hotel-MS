import { STAFF_ROLES, type StaffRole } from '@hospitality/constants';
import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { runWithTenant } from '../../shared/request-context';
import { SEED_PASSWORD, seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Staff } from './staff.model';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
const t = buildTestApp();

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

const as = async (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

const newStaff = (overrides: Record<string, unknown> = {}) => ({
  name: 'Asha Rao',
  email: `asha.${new Types.ObjectId().toHexString().slice(-6)}@grandplaza.example`,
  role: 'front_desk',
  ...overrides,
});

describe('who may use the staff routes (every role against every route)', () => {
  const allowed: StaffRole[] = ['platform_admin', 'property_admin', 'manager'];
  const someId = '65f000000000000000000001';
  const routes: { name: string; call: (c: Client) => Promise<{ status: number }> }[] = [
    { name: 'GET /staff', call: (c) => c.get('/api/v1/staff') },
    { name: 'GET /staff/:id', call: (c) => c.get(`/api/v1/staff/${someId}`) },
    { name: 'POST /staff', call: (c) => c.post('/api/v1/staff', {}) },
    {
      name: 'PATCH /staff/:id',
      call: (c) => c.patch(`/api/v1/staff/${someId}`, { active: false }),
    },
    {
      name: 'POST /staff/:id/reset-password',
      call: (c) => c.post(`/api/v1/staff/${someId}/reset-password`),
    },
  ];

  for (const role of STAFF_ROLES) {
    for (const route of routes) {
      it(`${role} ${allowed.includes(role) ? 'may reach' : 'is refused (403) on'} ${route.name}`, async () => {
        const client = await as(a, role);
        const { status } = await route.call(client);
        if (allowed.includes(role)) {
          expect([401, 403]).not.toContain(status);
        } else {
          expect(status).toBe(403);
        }
      });
    }
  }

  it('answers 401, not 403, when nobody is signed in', async () => {
    for (const route of routes) {
      expect((await route.call(t.anonymous)).status).toBe(401);
    }
  });
});

describe('POST /api/v1/staff', () => {
  it('creates an account with a one-time temporary password the person must change', async () => {
    const manager = await as(a, 'manager');
    const input = newStaff({ role: 'kitchen' });
    const res = await manager.post('/api/v1/staff', input);
    expect(res.status).toBe(201);
    expect(res.body.data.staff).toMatchObject({
      email: input.email,
      role: 'kitchen',
      departments: ['kitchen'],
      active: true,
      mustChangePassword: true,
    });
    expect(res.body.data.temporaryPassword).toMatch(/^[A-Za-z0-9]{14}$/);

    const login = await t.anonymous.post('/api/v1/auth/login', {
      propertySlug: 'grand-plaza',
      email: input.email,
      password: res.body.data.temporaryPassword,
    });
    expect(login.status).toBe(200);
    expect(login.body.data.staff.mustChangePassword).toBe(true);
  });

  it('never stores or returns the password in clear', async () => {
    const manager = await as(a, 'manager');
    const res = await manager.post('/api/v1/staff', newStaff());
    const stored = await runWithTenant(a.id, () =>
      Staff.findOne({ email: res.body.data.staff.email }).select('+passwordHash').lean(),
    );
    expect(stored?.passwordHash).not.toContain(res.body.data.temporaryPassword);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });

  it('ignores a propertyId, role-escalation fields or active flag sent by the client', async () => {
    const manager = await as(a, 'manager');
    const input = newStaff();
    const res = await manager.post('/api/v1/staff', {
      ...input,
      propertyId: b.id.toHexString(),
      passwordHash: 'x',
      mustChangePassword: false,
      active: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.staff.propertyId).toBe(a.id.toHexString());
    expect(res.body.data.staff.mustChangePassword).toBe(true);
    expect(res.body.data.staff.active).toBe(true);
    // And it really is not in property B.
    expect(await runWithTenant(b.id, () => Staff.countDocuments({ email: input.email }))).toBe(0);
  });

  it.each([
    ['manager', 'manager'],
    ['manager', 'property_admin'],
    ['property_admin', 'property_admin'],
  ] as const)('refuses a %s creating a %s (role at or above their own)', async (actor, role) => {
    const client = await as(a, actor);
    const res = await client.post('/api/v1/staff', newStaff({ role }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('role_too_high');
  });

  it('lets a property admin create a manager', async () => {
    const admin = await as(a, 'property_admin');
    expect((await admin.post('/api/v1/staff', newStaff({ role: 'manager' }))).status).toBe(201);
  });

  it('never lets anyone create a platform_admin through the API', async () => {
    const admin = await as(a, 'platform_admin');
    const res = await admin.post('/api/v1/staff', newStaff({ role: 'platform_admin' }));
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate email in the same property with 409, but allows it in another', async () => {
    const manager = await as(a, 'manager');
    const input = newStaff();
    expect((await manager.post('/api/v1/staff', input)).status).toBe(201);
    const dup = await manager.post('/api/v1/staff', { ...input, email: input.email.toUpperCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('email_taken');

    const otherManager = await as(b, 'manager');
    expect((await otherManager.post('/api/v1/staff', input)).status).toBe(201);
  });

  it('validates the request', async () => {
    const manager = await as(a, 'manager');
    for (const bad of [
      {},
      { name: '', email: 'x', role: 'front_desk' },
      newStaff({ role: 'janitor' }),
    ]) {
      expect((await manager.post('/api/v1/staff', bad)).status).toBe(400);
    }
  });

  it('records who created the account in the audit log', async () => {
    const manager = await as(a, 'manager');
    const res = await manager.post('/api/v1/staff', newStaff());
    const entries = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'staff.created', 'target.id': res.body.data.staff.id }).lean(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actor).toMatchObject({
      kind: 'staff',
      id: a.staff.manager?.id.toHexString(),
    });
    expect(JSON.stringify(entries[0])).not.toContain(res.body.data.temporaryPassword);
  });
});

describe('GET /api/v1/staff', () => {
  it('lists only the caller’s property, with paging', async () => {
    const manager = await as(a, 'manager');
    const res = await manager.get('/api/v1/staff?limit=3&page=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 3 });
    expect(res.body.meta.total).toBeGreaterThanOrEqual(STAFF_ROLES.length);

    const all = await manager.get('/api/v1/staff?limit=100');
    for (const item of all.body.data) expect(item.propertyId).toBe(a.id.toHexString());
    const ids = all.body.data.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(b.staff.manager?.id.toHexString());
  });

  it('filters by role and active state', async () => {
    const manager = await as(a, 'manager');
    const res = await manager.get('/api/v1/staff?role=kitchen&active=true');
    expect(res.body.data.every((s: { role: string }) => s.role === 'kitchen')).toBe(true);
  });

  it('caps the page size', async () => {
    const manager = await as(a, 'manager');
    expect((await manager.get('/api/v1/staff?limit=100000')).status).toBe(400);
  });
});

describe('cross-property access', () => {
  it('cannot read, change or reset an account of another property (404, not 403)', async () => {
    const managerA = await as(a, 'manager');
    const target = b.staff.front_desk?.id.toHexString() ?? '';
    expect((await managerA.get(`/api/v1/staff/${target}`)).status).toBe(404);
    expect((await managerA.patch(`/api/v1/staff/${target}`, { active: false })).status).toBe(404);
    expect((await managerA.post(`/api/v1/staff/${target}/reset-password`)).status).toBe(404);

    const stillActive = await runWithTenant(b.id, () => Staff.findOne({ _id: target }).lean());
    expect(stillActive?.active).toBe(true);
  });
});

describe('PATCH /api/v1/staff/:id', () => {
  async function createdBy(client: Client, role = 'front_desk') {
    const res = await client.post('/api/v1/staff', newStaff({ role }));
    return res.body.data.staff as { id: string; role: string };
  }

  it('changes name and role, and the audit log keeps the before and after', async () => {
    const manager = await as(a, 'manager');
    const created = await createdBy(manager);
    const res = await manager.patch(`/api/v1/staff/${created.id}`, {
      name: 'New Name',
      role: 'housekeeping',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'New Name',
      role: 'housekeeping',
      departments: ['housekeeping'],
    });

    const entries = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'staff.updated', 'target.id': created.id }).lean(),
    );
    expect(entries[0]?.summary).toMatchObject({
      before: { role: 'front_desk' },
      after: { role: 'housekeeping' },
    });
  });

  it('refuses to promote someone to a role at or above the caller’s', async () => {
    const manager = await as(a, 'manager');
    const created = await createdBy(manager);
    const res = await manager.patch(`/api/v1/staff/${created.id}`, { role: 'manager' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('role_too_high');
  });

  it('refuses to touch an account at or above the caller’s role', async () => {
    const manager = await as(a, 'manager');
    for (const target of [a.staff.property_admin, a.staff.platform_admin]) {
      const res = await manager.patch(`/api/v1/staff/${target?.id.toHexString()}`, {
        active: false,
      });
      expect(res.status).toBe(403);
    }
    const peer = await createdBy(await as(a, 'property_admin'), 'manager');
    expect((await manager.patch(`/api/v1/staff/${peer.id}`, { active: false })).status).toBe(403);
    expect((await manager.post(`/api/v1/staff/${peer.id}/reset-password`)).status).toBe(403);
  });

  it('refuses to let someone change their own account here', async () => {
    const manager = await as(a, 'manager');
    const own = a.staff.manager?.id.toHexString() ?? '';
    const res = await manager.patch(`/api/v1/staff/${own}`, { active: false });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('cannot_manage_self');
  });

  it('deactivating cuts off access at once, including refresh', async () => {
    const manager = await as(a, 'manager');
    const input = newStaff();
    const created = await manager.post('/api/v1/staff', input);
    const login = await t.anonymous.post('/api/v1/auth/login', {
      propertySlug: 'grand-plaza',
      email: input.email,
      password: created.body.data.temporaryPassword,
    });
    const { accessToken, refreshToken } = login.body.data.tokens;

    const off = await manager.patch(`/api/v1/staff/${created.body.data.staff.id}`, {
      active: false,
    });
    expect(off.status).toBe(200);

    expect((await t.withToken(accessToken).get('/api/v1/auth/me')).status).toBe(401);
    expect((await t.anonymous.post('/api/v1/auth/refresh', { refreshToken })).status).toBe(401);
    const again = await t.anonymous.post('/api/v1/auth/login', {
      propertySlug: 'grand-plaza',
      email: input.email,
      password: created.body.data.temporaryPassword,
    });
    expect(again.status).toBe(401);
  });

  it('a demotion takes effect on the very next request', async () => {
    const admin = await as(a, 'property_admin');
    const created = await admin.post('/api/v1/staff', newStaff({ role: 'manager' }));
    const id = created.body.data.staff.id as string;
    const sessionClient = await t.actAs(new Types.ObjectId(id), a.id);
    // Clear the temporary-password flag so the route itself can be used.
    await runWithTenant(a.id, () => Staff.updateOne({ _id: id }, { mustChangePassword: false }));
    expect((await sessionClient.get('/api/v1/staff')).status).toBe(200);

    await admin.patch(`/api/v1/staff/${id}`, { role: 'front_desk' });
    expect((await sessionClient.get('/api/v1/staff')).status).toBe(403);
  });

  it('ignores propertyId and passwordHash in the body', async () => {
    const manager = await as(a, 'manager');
    const created = await createdBy(manager);
    const res = await manager.patch(`/api/v1/staff/${created.id}`, {
      name: 'Still Here',
      propertyId: b.id.toHexString(),
      passwordHash: 'x',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.propertyId).toBe(a.id.toHexString());
  });

  it('rejects an empty change and a bad id', async () => {
    const manager = await as(a, 'manager');
    const created = await createdBy(manager);
    expect((await manager.patch(`/api/v1/staff/${created.id}`, {})).status).toBe(400);
    expect((await manager.patch('/api/v1/staff/not-an-id', { active: false })).status).toBe(400);
  });

  it('answers 404 for an unknown id', async () => {
    const manager = await as(a, 'manager');
    expect(
      (await manager.patch(`/api/v1/staff/${new Types.ObjectId()}`, { active: false })).status,
    ).toBe(404);
  });
});

describe('POST /api/v1/staff/:id/reset-password', () => {
  it('sets a new temporary password, unlocks the account and ends its sessions', async () => {
    const manager = await as(a, 'manager');
    const input = newStaff();
    const created = await manager.post('/api/v1/staff', input);
    const id = created.body.data.staff.id as string;
    const login = await t.anonymous.post('/api/v1/auth/login', {
      propertySlug: 'grand-plaza',
      email: input.email,
      password: created.body.data.temporaryPassword,
    });

    await runWithTenant(a.id, () =>
      Staff.updateOne(
        { _id: id },
        { lockedUntil: new Date(Date.now() + 600_000), failedLoginCount: 3 },
      ),
    );

    const reset = await manager.post(`/api/v1/staff/${id}/reset-password`);
    expect(reset.status).toBe(200);
    expect(reset.body.data.temporaryPassword).not.toBe(created.body.data.temporaryPassword);
    expect(reset.body.data.staff.mustChangePassword).toBe(true);

    expect(
      (
        await t.anonymous.post('/api/v1/auth/refresh', {
          refreshToken: login.body.data.tokens.refreshToken,
        })
      ).status,
    ).toBe(401);
    const old = await t.anonymous.post('/api/v1/auth/login', {
      propertySlug: 'grand-plaza',
      email: input.email,
      password: created.body.data.temporaryPassword,
    });
    expect(old.status).toBe(401);
    const fresh = await t.anonymous.post('/api/v1/auth/login', {
      propertySlug: 'grand-plaza',
      email: input.email,
      password: reset.body.data.temporaryPassword,
    });
    expect(fresh.status).toBe(200);

    const entries = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'staff.password_reset', 'target.id': id }).lean(),
    );
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain(reset.body.data.temporaryPassword);
  });
});

describe('the seed password is only for development data', () => {
  it('is long enough to meet the password rules', () => {
    expect(SEED_PASSWORD.length).toBeGreaterThanOrEqual(10);
  });
});
