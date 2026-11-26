import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { Types } from 'mongoose';
import type { Env } from '../../config/environment';
import { HttpError, unauthorized } from '../../shared/errors';
import { RefreshToken } from './refresh-token.model';

const ISSUER = 'hospitality-platform';
const STAFF_AUDIENCE = 'staff';
const DAY_MS = 86_400_000;

export interface AccessClaims {
  staffId: Types.ObjectId;
  propertyId: Types.ObjectId;
}

export interface IssuedRefreshToken extends AccessClaims {
  /** The secret value handed to the client. It is shown once and never stored. */
  token: string;
  family: string;
}

export interface TokenService {
  /** How long an access token lives, in seconds. */
  readonly accessTtlSeconds: number;
  signAccessToken(claims: AccessClaims): Promise<string>;
  /** Throws if the token is forged, expired, for the wrong audience, or malformed. */
  verifyAccessToken(jwt: string): Promise<AccessClaims>;
  issueRefreshToken(claims: AccessClaims, family?: string): Promise<IssuedRefreshToken>;
  /** Spends a refresh token and returns its replacement. A reused token revokes its family. */
  rotateRefreshToken(token: string): Promise<IssuedRefreshToken>;
  revokeFamilyOf(token: string): Promise<void>;
  revokeAllFor(staffId: Types.ObjectId): Promise<void>;
}

const invalidRefresh = (): HttpError =>
  unauthorized('Your session has expired, please sign in again', 'invalid_refresh_token');

function objectIdOrThrow(value: unknown): Types.ObjectId {
  if (typeof value !== 'string' || !Types.ObjectId.isValid(value) || value.length !== 24) {
    throw new Error('Malformed id in token');
  }
  return new Types.ObjectId(value);
}

/**
 * Access tokens are short-lived signed JWTs that say only *who* is calling. Role, department
 * and active state are always re-read from the database, so a deactivated or demoted account
 * loses access immediately, not when its token expires.
 *
 * Refresh tokens are random opaque values. Only a keyed hash is stored, each use replaces the
 * token, and using an already-spent token is treated as theft and revokes the whole family.
 */
export function createTokenService(env: Env): TokenService {
  const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  const hashToken = (token: string): string =>
    createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex');

  const service: TokenService = {
    accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,

    signAccessToken({ staffId, propertyId }) {
      return new SignJWT({ pid: propertyId.toHexString() })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(staffId.toHexString())
        .setIssuer(ISSUER)
        .setAudience(STAFF_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
        .sign(accessKey);
    },

    async verifyAccessToken(jwt) {
      const { payload } = await jwtVerify(jwt, accessKey, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: STAFF_AUDIENCE,
      });
      return { staffId: objectIdOrThrow(payload.sub), propertyId: objectIdOrThrow(payload.pid) };
    },

    async issueRefreshToken({ staffId, propertyId }, family = randomUUID()) {
      const token = randomBytes(32).toString('base64url');
      await RefreshToken.create({
        tokenHash: hashToken(token),
        family,
        principal: { kind: 'staff', id: staffId },
        propertyId,
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
      });
      return { token, family, staffId, propertyId };
    },

    async rotateRefreshToken(token) {
      const tokenHash = hashToken(token);

      // Spend the token. Only one of several parallel requests can match `usedAt: null`.
      const spent = await RefreshToken.findOneAndUpdate(
        { tokenHash, usedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { usedAt: new Date() } },
      ).lean();

      if (!spent) {
        const known = await RefreshToken.findOne({ tokenHash }).lean();
        if (known?.usedAt && known.expiresAt > new Date()) {
          await RefreshToken.deleteMany({ family: known.family });
          throw new HttpError(
            401,
            'refresh_reused',
            'Your session has expired, please sign in again',
          );
        }
        throw invalidRefresh();
      }

      return service.issueRefreshToken(
        { staffId: spent.principal.id, propertyId: spent.propertyId },
        spent.family,
      );
    },

    async revokeFamilyOf(token) {
      const known = await RefreshToken.findOne({ tokenHash: hashToken(token) }).lean();
      if (known) await RefreshToken.deleteMany({ family: known.family });
    },

    async revokeAllFor(staffId) {
      await RefreshToken.deleteMany({ 'principal.id': staffId });
    },
  };

  return service;
}
