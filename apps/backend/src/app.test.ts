import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from './app';
import { parseEnv, type Env } from './config/environment';

const baseEnv: Record<string, string> = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/hospitality_platform?replicaSet=rs0',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:5174',
};

function build(
  overrides: Record<string, string> = {},
  options: Partial<AppOptions> = {},
): ReturnType<typeof createApp> {
  const env: Env = parseEnv({ ...baseEnv, ...overrides });
  return createApp({
    env,
    logger: pino({ level: 'silent' }),
    checkDatabase: () => true,
    ...options,
  });
}

describe('GET /health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await request(build()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok', database: 'up' } });
  });

  it('answers 503 when the database is not reachable', async () => {
    const res = await request(build({}, { checkDatabase: () => false })).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('unhealthy');
  });

  it('does not reveal versions or internals', async () => {
    const res = await request(build()).get('/health');
    expect(JSON.stringify(res.body)).not.toMatch(/express|mongoose|node|version/i);
  });

  it('is not rate limited, so uptime checks never trip the limiter', async () => {
    const app = build({}, { rateLimit: { windowMs: 60_000, limit: 2 } });
    for (let i = 0; i < 6; i++) {
      expect((await request(app).get('/health')).status).toBe(200);
    }
  });
});

describe('security and platform behaviour', () => {
  it('sets security headers and hides the framework', async () => {
    const res = await request(build()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('returns a request id on every response, including errors', async () => {
    const ok = await request(build()).get('/health');
    const missing = await request(build()).get('/nope');
    expect(ok.headers['x-request-id']).toBeDefined();
    expect(missing.headers['x-request-id']).toBeDefined();
  });

  it('answers unknown routes with a 404 envelope', async () => {
    const res = await request(build()).get('/definitely/not/here');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const app = build();
    const bad = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('bad_json');

    const big = await request(app)
      .post('/health')
      .send({ x: 'y'.repeat(150_000) });
    expect(big.status).toBe(413);
  });

  it('rate limits the API with the standard 429 envelope', async () => {
    const app = build({}, { rateLimit: { windowMs: 60_000, limit: 3 } });
    for (let i = 0; i < 3; i++) await request(app).get('/anything');
    const blocked = await request(app).get('/anything');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  });
});

describe('CORS allow-list', () => {
  it('allows a configured origin', async () => {
    const res = await request(build()).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not grant access to any other origin', async () => {
    const res = await request(build()).get('/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight for an allowed origin only', async () => {
    const app = build();
    const allowed = await request(app)
      .options('/health')
      .set('Origin', 'http://localhost:5174')
      .set('Access-Control-Request-Method', 'POST');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5174');

    const denied = await request(app)
      .options('/health')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('API documentation', () => {
  it('serves Swagger UI and the OpenAPI document when enabled', async () => {
    const app = build({ ENABLE_DOCS: 'true' });
    const ui = await request(app).get('/docs/');
    expect(ui.status).toBe(200);
    expect(ui.headers['content-type']).toMatch(/html/);

    const spec = await request(app).get('/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toMatch(/^3\./);
    expect(spec.body.paths['/health']).toBeDefined();
  });

  it('is not served when disabled', async () => {
    const app = build({ NODE_ENV: 'production', ENABLE_DOCS: 'false' });
    expect((await request(app).get('/docs/')).status).toBe(404);
    expect((await request(app).get('/openapi.json')).status).toBe(404);
  });
});
