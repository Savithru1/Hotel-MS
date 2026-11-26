import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp } from '../../../test/http';
import { runWithTenant } from '../../shared/request-context';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { SEED_PASSWORD, seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Staff } from '../staff/staff.model';
import { RefreshToken } from './refresh-token.model';
import { LOCKOUT_MS, MAX_FAILED_LOGINS } from './auth.service';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
const t = buildTestApp();

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

const credentials = (email: string, password = SEED_PASSWORD, slug = 'grand-plaza') => ({
  propertySlug: slug,
  email,
  password,
});

const frontDeskEmail = () => a.staff.front_desk?.email ?? '';

describe('POST /api/v1/auth/login', () => {
  it('signs a staff member in and returns tokens, the account and the property', async () => {
    const res = await t.anonymous.post('/api/v1/auth/login', credentials(frontDeskEmail()));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { tokens, staff, property } = res.body.data;
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresIn).toBe(900);
    expect(staff).toMatchObject({ role: 'front_desk', active: true, departments: ['front_desk'] });
    expect(property).toMatchObject({ slug: 'grand-plaza', name: 'Grand Plaza' });
  });

  it('never returns a password hash or lock counters', async () => {
    const res = await t.anonymous.post('/api/v1/auth/login', credentials(frontDeskEmail()));
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/passwordHash|\$2[aby]\$|failedLoginCount|lockedUntil/);
  });

  it('accepts the email in any letter case', async () => {
    const res = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(frontDeskEmail().toUpperCase()),
    );
    expect(res.status).toBe(200);
  });

  it('gives the same answer for a wrong password, an unknown email and an unknown property', async () => {
    const wrongPassword = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(frontDeskEmail(), 'Wrong-Password-1'),
    );
    const unknownEmail = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials('nobody@grandplaza.example'),
    );
    const unknownProperty = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(frontDeskEmail(), SEED_PASSWORD, 'no-such-hotel'),
    );
    for (const res of [wrongPassword, unknownEmail, unknownProperty]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('invalid_credentials');
    }
    expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
    expect(unknownProperty.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('does not let a staff member of one property sign in to another', async () => {
    const res = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(frontDeskEmail(), SEED_PASSWORD, 'sea-view'),
    );
    expect(res.status).toBe(401);
  });

  it('refuses a malformed request without echoing it', async () => {
    const res = await t.anonymous.post('/api/v1/auth/login', {
      propertySlug: 'grand-plaza',
      email: 'not-an-email',
      password: 'secret-value-123',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('secret-value-123');
  });

  it('refuses a deactivated account', async () => {
    const target = b.staff.kitchen;
    await runWithTenant(b.id, () => Staff.updateOne({ _id: target?.id }, { active: false }));
    const res = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(target?.email ?? '', SEED_PASSWORD, 'sea-view'),
    );
    expect(res.status).toBe(401);
    await runWithTenant(b.id, () => Staff.updateOne({ _id: target?.id }, { active: true }));
  });

  it('writes sign-ins and failures to the audit log', async () => {
    const email = a.staff.maintenance?.email ?? '';
    await t.anonymous.post('/api/v1/auth/login', credentials(email, 'Wrong-Password-1'));
    await t.anonymous.post('/api/v1/auth/login', credentials(email));
    const actions = await runWithTenant(a.id, () =>
      AuditLog.find({ 'target.id': a.staff.maintenance?.id.toHexString() }).lean(),
    );
    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['auth.login_failed', 'auth.login']),
    );
    const failure = actions.find((entry) => entry.action === 'auth.login_failed');
    expect(JSON.stringify(failure)).not.toContain('Wrong-Password-1');
  });
});

describe('account lockout', () => {
  it('locks after repeated wrong passwords, even for the right password, then recovers', async () => {
    const target = a.staff.spa_recreation;
    const email = target?.email ?? '';
    const app = buildTestApp({
      loginLimits: { windowMs: 60_000, perAddress: 1000, perAddressAndAccount: 1000 },
    });

    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      const res = await app.anonymous.post(
        '/api/v1/auth/login',
        credentials(email, 'Wrong-Password-1'),
      );
      expect(res.status).toBe(401);
    }
    const locked = await app.anonymous.post('/api/v1/auth/login', credentials(email));
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('invalid_credentials');

    const record = await runWithTenant(a.id, () => Staff.findOne({ _id: target?.id }).lean());
    expect(record?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(record?.lockedUntil?.getTime()).toBeLessThanOrEqual(Date.now() + LOCKOUT_MS);

    // Time passes: the lock ends and the right password works again.
    await runWithTenant(a.id, () =>
      Staff.updateOne({ _id: target?.id }, { lockedUntil: new Date(Date.now() - 1000) }),
    );
    const after = await app.anonymous.post('/api/v1/auth/login', credentials(email));
    expect(after.status).toBe(200);
    const cleared = await runWithTenant(a.id, () => Staff.findOne({ _id: target?.id }).lean());
    expect(cleared?.failedLoginCount).toBe(0);
    expect(cleared?.lockedUntil).toBeNull();
  });

  it('counts failures per account, so one account locking does not lock another', async () => {
    const app = buildTestApp({
      loginLimits: { windowMs: 60_000, perAddress: 1000, perAddressAndAccount: 1000 },
    });
    const victim = a.staff.kitchen?.email ?? '';
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await app.anonymous.post('/api/v1/auth/login', credentials(victim, 'Wrong-Password-1'));
    }
    const other = await app.anonymous.post(
      '/api/v1/auth/login',
      credentials(a.staff.housekeeping?.email ?? ''),
    );
    expect(other.status).toBe(200);
  });
});

describe('sign-in rate limiting', () => {
  it('limits attempts against one account from one address with 429', async () => {
    const app = buildTestApp({
      loginLimits: { windowMs: 60_000, perAddress: 1000, perAddressAndAccount: 3 },
    });
    const email = a.staff.manager?.email ?? '';
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await app.anonymous.post('/api/v1/auth/login', credentials(email))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('limits all attempts from one address', async () => {
    const app = buildTestApp({
      loginLimits: { windowMs: 60_000, perAddress: 2, perAddressAndAccount: 1000 },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (await app.anonymous.post('/api/v1/auth/login', credentials(`x${i}@grandplaza.example`)))
          .status,
      );
    }
    expect(statuses).toEqual([401, 401, 429, 429]);
  });
});

describe('access tokens on protected routes', () => {
  async function session(email: string, slug = 'grand-plaza') {
    const res = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(email, SEED_PASSWORD, slug),
    );
    return res.body.data as {
      tokens: { accessToken: string; refreshToken: string };
      staff: { id: string };
    };
  }

  it('GET /auth/me returns the signed-in account, from the token only', async () => {
    const { tokens } = await session(a.staff.manager?.email ?? '');
    const res = await t.withToken(tokens.accessToken).get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.data.staff.role).toBe('manager');
    expect(res.body.data.property.slug).toBe('grand-plaza');
  });

  it.each([
    ['no token', undefined],
    ['garbage', 'not-a-token'],
    ['empty bearer', ''],
  ])('rejects %s with 401', async (_name, token) => {
    const client = token === undefined ? t.anonymous : t.withToken(token);
    const res = await client.get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects a token that is not a Bearer token', async () => {
    const { tokens } = await session(a.staff.manager?.email ?? '');
    const { default: request } = await import('supertest');
    const res = await request(t.app)
      .get('/api/v1/auth/me')
      .set('Authorization', tokens.accessToken);
    expect(res.status).toBe(401);
  });

  it('rejects a valid token once the account is deactivated, at once', async () => {
    const { tokens, staff } = await session(b.staff.housekeeping?.email ?? '', 'sea-view');
    const client = t.withToken(tokens.accessToken);
    expect((await client.get('/api/v1/auth/me')).status).toBe(200);
    await runWithTenant(b.id, () => Staff.updateOne({ _id: staff.id }, { active: false }));
    expect((await client.get('/api/v1/auth/me')).status).toBe(401);
    await runWithTenant(b.id, () => Staff.updateOne({ _id: staff.id }, { active: true }));
  });

  it('rejects a token for a staff id that does not exist in the claimed property', async () => {
    // Signed correctly, but property B's staff id presented with property A as the tenant.
    const bStaff = b.staff.manager?.id ?? new Types.ObjectId();
    const forged = await t.tokens.signAccessToken({ staffId: bStaff, propertyId: a.id });
    const res = await t.withToken(forged).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/refresh and /logout', () => {
  async function fresh() {
    const res = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(a.staff.front_desk?.email ?? ''),
    );
    return res.body.data.tokens as { accessToken: string; refreshToken: string };
  }

  it('exchanges a refresh token for a new session and retires the old token', async () => {
    const first = await fresh();
    const res = await t.anonymous.post('/api/v1/auth/refresh', {
      refreshToken: first.refreshToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.tokens.refreshToken).not.toBe(first.refreshToken);
    expect(res.body.data.staff.role).toBe('front_desk');

    const reuse = await t.anonymous.post('/api/v1/auth/refresh', {
      refreshToken: first.refreshToken,
    });
    expect(reuse.status).toBe(401);
  });

  it('revokes the whole chain when a spent token is replayed', async () => {
    const first = await fresh();
    const second = await t.anonymous.post('/api/v1/auth/refresh', {
      refreshToken: first.refreshToken,
    });
    await t.anonymous.post('/api/v1/auth/refresh', { refreshToken: first.refreshToken });
    const newest = second.body.data.tokens.refreshToken as string;
    const res = await t.anonymous.post('/api/v1/auth/refresh', { refreshToken: newest });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown or malformed refresh token', async () => {
    expect(
      (await t.anonymous.post('/api/v1/auth/refresh', { refreshToken: 'a'.repeat(43) })).status,
    ).toBe(401);
    expect((await t.anonymous.post('/api/v1/auth/refresh', { refreshToken: 'short' })).status).toBe(
      400,
    );
  });

  it('refuses to refresh for an account deactivated in the meantime', async () => {
    const target = b.staff.spa_recreation;
    const login = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(target?.email ?? '', SEED_PASSWORD, 'sea-view'),
    );
    await runWithTenant(b.id, () => Staff.updateOne({ _id: target?.id }, { active: false }));
    const res = await t.anonymous.post('/api/v1/auth/refresh', {
      refreshToken: login.body.data.tokens.refreshToken,
    });
    expect(res.status).toBe(401);
    await runWithTenant(b.id, () => Staff.updateOne({ _id: target?.id }, { active: true }));
  });

  it('logout revokes the refresh token, and signing out twice is fine', async () => {
    const tokens = await fresh();
    const out = await t.anonymous.post('/api/v1/auth/logout', {
      refreshToken: tokens.refreshToken,
    });
    expect(out.status).toBe(200);
    expect(
      (await t.anonymous.post('/api/v1/auth/logout', { refreshToken: tokens.refreshToken })).status,
    ).toBe(200);
    const res = await t.anonymous.post('/api/v1/auth/refresh', {
      refreshToken: tokens.refreshToken,
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/change-password', () => {
  it('changes the password, ends other sessions and returns a fresh session', async () => {
    const email = a.staff.property_admin?.email ?? '';
    const login = await t.anonymous.post('/api/v1/auth/login', credentials(email));
    const { accessToken, refreshToken } = login.body.data.tokens;

    const res = await t.withToken(accessToken).post('/api/v1/auth/change-password', {
      currentPassword: SEED_PASSWORD,
      newPassword: 'Brand-New-Pass-77',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.tokens.refreshToken).toBeTruthy();

    // The old refresh token no longer works, the old password no longer works, the new one does.
    expect((await t.anonymous.post('/api/v1/auth/refresh', { refreshToken })).status).toBe(401);
    expect((await t.anonymous.post('/api/v1/auth/login', credentials(email))).status).toBe(401);
    expect(
      (await t.anonymous.post('/api/v1/auth/login', credentials(email, 'Brand-New-Pass-77')))
        .status,
    ).toBe(200);

    // Put it back for the other tests.
    const again = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(email, 'Brand-New-Pass-77'),
    );
    await t.withToken(again.body.data.tokens.accessToken).post('/api/v1/auth/change-password', {
      currentPassword: 'Brand-New-Pass-77',
      newPassword: SEED_PASSWORD,
    });
  });

  it('needs the correct current password', async () => {
    const login = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(a.staff.manager?.email ?? ''),
    );
    const res = await t
      .withToken(login.body.data.tokens.accessToken)
      .post('/api/v1/auth/change-password', {
        currentPassword: 'Not-The-Password-1',
        newPassword: 'Another-Pass-1234',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('wrong_password');
  });

  it('refuses a weak new password and an unchanged one', async () => {
    const login = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(a.staff.manager?.email ?? ''),
    );
    const client = t.withToken(login.body.data.tokens.accessToken);
    expect(
      (
        await client.post('/api/v1/auth/change-password', {
          currentPassword: SEED_PASSWORD,
          newPassword: 'weak',
        })
      ).status,
    ).toBe(400);
    const same = await client.post('/api/v1/auth/change-password', {
      currentPassword: SEED_PASSWORD,
      newPassword: SEED_PASSWORD,
    });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('password_unchanged');
  });

  it('keeps an account with a temporary password out of everything except changing it', async () => {
    // Uses its own account because the password changes for good.
    const target = a.staff.housekeeping;
    await runWithTenant(a.id, () =>
      Staff.updateOne({ _id: target?.id }, { mustChangePassword: true }),
    );
    const client = await t.actAs(target?.id ?? new Types.ObjectId(), a.id);

    expect((await client.get('/api/v1/auth/me')).status).toBe(200);
    const blocked = await client.get('/api/v1/staff');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('password_change_required');

    const changed = await client.post('/api/v1/auth/change-password', {
      currentPassword: SEED_PASSWORD,
      newPassword: 'Changed-Pass-4242',
    });
    expect(changed.status).toBe(200);
    expect(changed.body.data.staff.mustChangePassword).toBe(false);
  });
});

describe('refresh token storage', () => {
  it('keeps only hashes in the database', async () => {
    const res = await t.anonymous.post(
      '/api/v1/auth/login',
      credentials(a.staff.manager?.email ?? ''),
    );
    const raw = res.body.data.tokens.refreshToken as string;
    const all = JSON.stringify(await RefreshToken.find().lean());
    expect(all).not.toContain(raw);
  });
});
