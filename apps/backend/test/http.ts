import type { Express } from 'express';
import type { Types } from 'mongoose';
import { pino } from 'pino';
import request from 'supertest';
import { createApp, type AppOptions } from '../src/app';
import type { Env } from '../src/config/environment';
import { createTokenService, type TokenService } from '../src/modules/auth/token.service';
import { testEnv } from './env';

export interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper, bodies are checked per test
  body: any;
}

export interface Client {
  get(path: string): Promise<Reply>;
  post(path: string, body?: unknown): Promise<Reply>;
  patch(path: string, body?: unknown): Promise<Reply>;
  put(path: string, body?: unknown): Promise<Reply>;
  delete(path: string): Promise<Reply>;
}

export interface TestApp {
  app: Express;
  env: Env;
  tokens: TokenService;
  /** A client that sends no credentials. */
  anonymous: Client;
  /** A client signed in as the given staff member, with no sign-in request needed. */
  actAs(staffId: Types.ObjectId, propertyId: Types.ObjectId): Promise<Client>;
  /** A client carrying an arbitrary bearer token (for forged or expired token tests). */
  withToken(token: string): Client;
}

function clientFor(app: Express, token?: string): Client {
  const auth = (req: request.Test): request.Test =>
    token ? req.set('Authorization', `Bearer ${token}`) : req;
  return {
    get: (path) => auth(request(app).get(path)),
    post: (path, body) => auth(request(app).post(path)).send(body as object),
    patch: (path, body) => auth(request(app).patch(path)).send(body as object),
    put: (path, body) => auth(request(app).put(path)).send(body as object),
    delete: (path) => auth(request(app).delete(path)),
  };
}

/**
 * Builds the real app (all middleware, validation, rate limits) around the test database.
 * `actAs` is the "act as a given user" helper: it signs a real access token for an existing
 * staff member, so requests go through the same authentication as production.
 */
export function buildTestApp(
  options: Partial<AppOptions> & { env?: Record<string, string> } = {},
): TestApp {
  const env = testEnv(options.env);
  const tokens = createTokenService(env);
  const app = createApp({
    env,
    logger: pino({ level: 'silent' }),
    checkDatabase: () => true,
    // Tests make many requests from one address; the limiter itself has its own tests.
    rateLimit: { windowMs: 60_000, limit: 100_000 },
    ...options,
  });

  return {
    app,
    env,
    tokens,
    anonymous: clientFor(app),
    async actAs(staffId, propertyId) {
      return clientFor(app, await tokens.signAccessToken({ staffId, propertyId }));
    },
    withToken: (token) => clientFor(app, token),
  };
}
