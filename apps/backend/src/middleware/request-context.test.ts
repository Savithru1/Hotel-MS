import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { getContext } from '../shared/request-context';
import { requestContext } from './request-context';

function buildApp(): express.Express {
  const app = express();
  app.use(requestContext());
  app.get('/ctx', async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    res.json({ requestId: getContext()?.requestId, ip: getContext()?.ip });
  });
  return app;
}

describe('requestContext middleware', () => {
  it('generates a request id, returns it in a header and exposes it to handlers', async () => {
    const res = await request(buildApp()).get('/ctx');
    const header = res.headers['x-request-id'];
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.requestId).toBe(header);
  });

  it('keeps a well-formed incoming request id', async () => {
    const res = await request(buildApp()).get('/ctx').set('X-Request-Id', 'trace-abc_123');
    expect(res.headers['x-request-id']).toBe('trace-abc_123');
    expect(res.body.requestId).toBe('trace-abc_123');
  });

  it.each([
    ['too long', 'x'.repeat(65)],
    ['spaces', 'bad id'],
    ['special characters', 'a;b<script>'],
  ])('replaces an unsafe incoming request id (%s)', async (_label, value) => {
    const res = await request(buildApp()).get('/ctx').set('X-Request-Id', value);
    expect(res.headers['x-request-id']).not.toBe(value);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives every request its own context', async () => {
    const app = buildApp();
    const [one, two] = await Promise.all([request(app).get('/ctx'), request(app).get('/ctx')]);
    expect(one.body.requestId).not.toBe(two.body.requestId);
    expect(one.body.requestId).toBe(one.headers['x-request-id']);
    expect(two.body.requestId).toBe(two.headers['x-request-id']);
  });

  it('records the client ip', async () => {
    const res = await request(buildApp()).get('/ctx');
    expect(typeof res.body.ip).toBe('string');
  });
});
