import { SignJWT } from 'jose';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { testEnv } from '../../../test/env';
import { RefreshToken } from './refresh-token.model';
import { createTokenService } from './token.service';

useTestDatabase();

const env = testEnv();
const tokens = createTokenService(env);
const staffId = new Types.ObjectId();
const propertyId = new Types.ObjectId();

describe('access tokens', () => {
  it('round-trips the staff id and property id', async () => {
    const jwt = await tokens.signAccessToken({ staffId, propertyId });
    const claims = await tokens.verifyAccessToken(jwt);
    expect(claims.staffId.equals(staffId)).toBe(true);
    expect(claims.propertyId.equals(propertyId)).toBe(true);
  });

  it('does not put the role or anything else a client could rely on in the token', async () => {
    const jwt = await tokens.signAccessToken({ staffId, propertyId });
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'pid', 'sub']);
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await new SignJWT({ pid: propertyId.toHexString() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(staffId.toHexString())
      .setIssuer('hospitality-platform')
      .setAudience('staff')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('x'.repeat(48)));
    await expect(tokens.verifyAccessToken(forged)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const expired = await new SignJWT({ pid: propertyId.toHexString() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(staffId.toHexString())
      .setIssuer('hospitality-platform')
      .setAudience('staff')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));
    await expect(tokens.verifyAccessToken(expired)).rejects.toThrow();
  });

  it('rejects a token for another audience (guest tokens must never work as staff)', async () => {
    const guest = await new SignJWT({ pid: propertyId.toHexString() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(staffId.toHexString())
      .setIssuer('hospitality-platform')
      .setAudience('guest')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));
    await expect(tokens.verifyAccessToken(guest)).rejects.toThrow();
  });

  it('rejects an unsigned (alg none) token', async () => {
    const header = Buffer.from('{"alg":"none"}').toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        sub: staffId.toHexString(),
        pid: propertyId.toHexString(),
        iss: 'hospitality-platform',
        aud: 'staff',
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');
    await expect(tokens.verifyAccessToken(`${header}.${body}.`)).rejects.toThrow();
  });

  it('rejects garbage', async () => {
    await expect(tokens.verifyAccessToken('not-a-token')).rejects.toThrow();
  });

  it('rejects a token with a malformed property id', async () => {
    const bad = await new SignJWT({ pid: 'nope' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(staffId.toHexString())
      .setIssuer('hospitality-platform')
      .setAudience('staff')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));
    await expect(tokens.verifyAccessToken(bad)).rejects.toThrow();
  });
});

describe('refresh tokens', () => {
  it('stores only a hash, never the token', async () => {
    const issued = await tokens.issueRefreshToken({ staffId, propertyId });
    const stored = await RefreshToken.find({ family: issued.family }).lean();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    expect(stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different tokens each time, with enough randomness', async () => {
    const a = await tokens.issueRefreshToken({ staffId, propertyId });
    const b = await tokens.issueRefreshToken({ staffId, propertyId });
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
  });

  it('sets an expiry for the database to enforce', async () => {
    const issued = await tokens.issueRefreshToken({ staffId, propertyId });
    const doc = await RefreshToken.findOne({ family: issued.family }).lean();
    const days = ((doc?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it('has a TTL index on expiresAt', async () => {
    await RefreshToken.init();
    const indexes = await RefreshToken.collection.indexes();
    const ttl = indexes.find((index) => index.key.expiresAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(0);
  });

  it('rotates: the old token stops working and a new one in the same family replaces it', async () => {
    const first = await tokens.issueRefreshToken({ staffId, propertyId });
    const rotated = await tokens.rotateRefreshToken(first.token);
    expect(rotated.staffId.equals(staffId)).toBe(true);
    expect(rotated.propertyId.equals(propertyId)).toBe(true);
    expect(rotated.family).toBe(first.family);
    expect(rotated.token).not.toBe(first.token);
    await expect(tokens.rotateRefreshToken(first.token)).rejects.toMatchObject({ status: 401 });
  });

  it('treats a reused token as theft and revokes the whole family', async () => {
    const first = await tokens.issueRefreshToken({ staffId, propertyId });
    const second = await tokens.rotateRefreshToken(first.token);
    await expect(tokens.rotateRefreshToken(first.token)).rejects.toMatchObject({
      code: 'refresh_reused',
    });
    // The legitimate newest token is gone too, so the thief and the owner must both sign in again.
    await expect(tokens.rotateRefreshToken(second.token)).rejects.toMatchObject({ status: 401 });
    expect(await RefreshToken.countDocuments({ family: first.family })).toBe(0);
  });

  it('does not touch other sign-ins of the same person when one family is revoked', async () => {
    const phone = await tokens.issueRefreshToken({ staffId, propertyId });
    const laptop = await tokens.issueRefreshToken({ staffId, propertyId });
    const rotated = await tokens.rotateRefreshToken(phone.token);
    await expect(tokens.rotateRefreshToken(phone.token)).rejects.toThrow();
    expect(rotated.token).toBeTruthy();
    await expect(tokens.rotateRefreshToken(laptop.token)).resolves.toBeTruthy();
  });

  it('rejects unknown and expired tokens the same way', async () => {
    await expect(tokens.rotateRefreshToken('x'.repeat(43))).rejects.toMatchObject({
      status: 401,
      code: 'invalid_refresh_token',
    });

    const issued = await tokens.issueRefreshToken({ staffId, propertyId });
    await RefreshToken.updateOne(
      { family: issued.family },
      { expiresAt: new Date(Date.now() - 1) },
    );
    await expect(tokens.rotateRefreshToken(issued.token)).rejects.toMatchObject({
      status: 401,
      code: 'invalid_refresh_token',
    });
  });

  it('only lets one of several parallel refreshes win', async () => {
    const issued = await tokens.issueRefreshToken({ staffId, propertyId });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => tokens.rotateRefreshToken(issued.token)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('revokes one family on logout, and logging out twice is harmless', async () => {
    const issued = await tokens.issueRefreshToken({ staffId, propertyId });
    await tokens.revokeFamilyOf(issued.token);
    await tokens.revokeFamilyOf(issued.token);
    await tokens.revokeFamilyOf('unknown-token-value-unknown-token-value');
    await expect(tokens.rotateRefreshToken(issued.token)).rejects.toMatchObject({ status: 401 });
  });

  it('revokes every sign-in of one person', async () => {
    const other = new Types.ObjectId();
    const mine1 = await tokens.issueRefreshToken({ staffId: other, propertyId });
    const mine2 = await tokens.issueRefreshToken({ staffId: other, propertyId });
    const notMine = await tokens.issueRefreshToken({ staffId, propertyId });
    await tokens.revokeAllFor(other);
    await expect(tokens.rotateRefreshToken(mine1.token)).rejects.toThrow();
    await expect(tokens.rotateRefreshToken(mine2.token)).rejects.toThrow();
    await expect(tokens.rotateRefreshToken(notMine.token)).resolves.toBeTruthy();
  });
});
