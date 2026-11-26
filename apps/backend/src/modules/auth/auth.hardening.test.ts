import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp } from '../../../test/http';
import { runAsPlatform, runWithTenant } from '../../shared/request-context';
import { Property } from '../properties/property.model';
import { SEED_PASSWORD, seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Staff } from '../staff/staff.model';
import { LOCKOUT_MS, MAX_FAILED_LOGINS } from './auth.service';
import { RefreshToken } from './refresh-token.model';
import { ABSOLUTE_SESSION_DAYS } from './token.service';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
const t = buildTestApp({
  loginLimits: { windowMs: 60_000, perAddress: 10_000, perAddressAndAccount: 10_000 },
});

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

const login = (email: string, slug: string, password = SEED_PASSWORD) =>
  t.anonymous.post('/api/v1/auth/login', { propertySlug: slug, email, password });

describe('a deactivated property', () => {
  it('cuts off sign-in, existing access tokens and refresh', async () => {
    const email = b.staff.manager?.email ?? '';
    const session = await login(email, 'sea-view');
    const { accessToken, refreshToken } = session.body.data.tokens;
    expect((await t.withToken(accessToken).get('/api/v1/auth/me')).status).toBe(200);

    await runAsPlatform(() => Property.updateOne({ _id: b.id }, { active: false }));
    try {
      expect((await t.withToken(accessToken).get('/api/v1/auth/me')).status).toBe(401);
      expect((await t.anonymous.post('/api/v1/auth/refresh', { refreshToken })).status).toBe(401);
      expect((await login(email, 'sea-view')).status).toBe(401);
    } finally {
      await runAsPlatform(() => Property.updateOne({ _id: b.id }, { active: true }));
    }
  });
});

describe('absolute session lifetime', () => {
  it('stops refreshing once the original sign-in is too old, however often it was used', async () => {
    const session = await login(a.staff.kitchen?.email ?? '', 'grand-plaza');
    const { refreshToken } = session.body.data.tokens;
    const old = new Date(Date.now() - (ABSOLUTE_SESSION_DAYS + 1) * 86_400_000);
    await RefreshToken.updateMany(
      { 'principal.id': a.staff.kitchen?.id },
      { familyCreatedAt: old },
    );
    const res = await t.anonymous.post('/api/v1/auth/refresh', { refreshToken });
    expect(res.status).toBe(401);
  });

  it('never lets a rotated token outlive the absolute limit', async () => {
    const session = await login(a.staff.maintenance?.email ?? '', 'grand-plaza');
    const nearEnd = new Date(Date.now() - (ABSOLUTE_SESSION_DAYS - 1) * 86_400_000);
    await RefreshToken.updateMany(
      { 'principal.id': a.staff.maintenance?.id },
      { familyCreatedAt: nearEnd },
    );
    const res = await t.anonymous.post('/api/v1/auth/refresh', {
      refreshToken: session.body.data.tokens.refreshToken,
    });
    expect(res.status).toBe(200);
    const doc = await RefreshToken.findOne({
      'principal.id': a.staff.maintenance?.id,
      usedAt: null,
    }).lean();
    const limit = nearEnd.getTime() + ABSOLUTE_SESSION_DAYS * 86_400_000;
    expect(doc?.expiresAt.getTime()).toBeLessThanOrEqual(limit);
  });
});

describe('tokens issued before a password change', () => {
  it('stop working as soon as the password has been changed or reset', async () => {
    const target = a.staff.spa_recreation;
    const first = await login(target?.email ?? '', 'grand-plaza');
    const oldToken = first.body.data.tokens.accessToken as string;
    expect((await t.withToken(oldToken).get('/api/v1/auth/me')).status).toBe(200);

    // Simulate a password reset that happened after this token was signed.
    await runWithTenant(a.id, () =>
      Staff.updateOne({ _id: target?.id }, { passwordChangedAt: new Date(Date.now() + 5000) }),
    );
    expect((await t.withToken(oldToken).get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('lockout cannot be extended or sidestepped', () => {
  it('does not push the lock further out when a locked account is hit again', async () => {
    const target = a.staff.front_desk;
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await login(target?.email ?? '', 'grand-plaza', 'Wrong-Password-1');
    }
    const before = await runWithTenant(a.id, () => Staff.findOne({ _id: target?.id }).lean());
    expect(before?.lockedUntil?.getTime()).toBeLessThanOrEqual(Date.now() + LOCKOUT_MS);

    for (let i = 0; i < 10; i++) {
      await login(target?.email ?? '', 'grand-plaza', 'Wrong-Password-1');
    }
    const after = await runWithTenant(a.id, () => Staff.findOne({ _id: target?.id }).lean());
    expect(after?.lockedUntil?.getTime()).toBe(before?.lockedUntil?.getTime());
  });

  it('counts wrong current passwords on change-password towards the lockout', async () => {
    const target = a.staff.property_admin;
    const client = await t.actAs(target?.id ?? new Types.ObjectId(), a.id);
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      const res = await client.post('/api/v1/auth/change-password', {
        currentPassword: 'Not-The-Password-1',
        newPassword: 'Another-Pass-1234',
      });
      expect(res.status).toBe(400);
    }
    const record = await runWithTenant(a.id, () => Staff.findOne({ _id: target?.id }).lean());
    expect(record?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    expect((await login(target?.email ?? '', 'grand-plaza')).status).toBe(401);
  });
});

describe('sign-in rate limit key', () => {
  it('treats padding and letter case as the same account', async () => {
    const app = buildTestApp({
      loginLimits: { windowMs: 60_000, perAddress: 1000, perAddressAndAccount: 2 },
    });
    const email = a.staff.manager?.email ?? '';
    const variants = [email, ` ${email}`, email.toUpperCase(), `${email} `];
    const statuses: number[] = [];
    for (const variant of variants) {
      statuses.push(
        (
          await app.anonymous.post('/api/v1/auth/login', {
            propertySlug: 'grand-plaza',
            email: variant,
            password: SEED_PASSWORD,
          })
        ).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
  });
});
