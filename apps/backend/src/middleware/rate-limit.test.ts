import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requestContext } from './request-context';
import { createRateLimiter } from './rate-limit';

function buildApp(limit: number): express.Express {
  const app = express();
  app.use(requestContext());
  app.use(createRateLimiter({ windowMs: 60_000, limit }));
  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('createRateLimiter', () => {
  it('allows requests up to the limit and then answers 429 in the standard envelope', async () => {
    const app = buildApp(2);
    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(200);

    const blocked = await request(app).get('/ping');
    expect(blocked.status).toBe(429);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.requestId).toBe(blocked.headers['x-request-id']);
  });

  it('tells clients when to retry', async () => {
    const app = buildApp(1);
    await request(app).get('/ping');
    const blocked = await request(app).get('/ping');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('keeps separate limiters independent', async () => {
    const one = buildApp(1);
    const two = buildApp(1);
    await request(one).get('/ping');
    expect((await request(one).get('/ping')).status).toBe(429);
    expect((await request(two).get('/ping')).status).toBe(200);
  });
});
