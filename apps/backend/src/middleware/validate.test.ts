import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from './error-handler';
import { requestContext } from './request-context';
import { validate } from './validate';

const bodySchema = z.object({ name: z.string().trim().min(1), nights: z.number().int().min(1) });
const querySchema = z.object({ page: z.coerce.number().int().min(1).default(1) });
const paramsSchema = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });

function buildApp(): express.Express {
  const app = express();
  app.use(requestContext());
  app.use(express.json());
  app.post(
    '/things/:id',
    validate({ body: bodySchema, query: querySchema, params: paramsSchema }),
    (req, res) => {
      res.json({ validated: req.validated });
    },
  );
  app.use(errorHandler(pino({ level: 'silent' })));
  return app;
}

const id = 'a'.repeat(24);

describe('validate middleware', () => {
  it('passes parsed, coerced data to the handler', async () => {
    const res = await request(buildApp())
      .post(`/things/${id}?page=3`)
      .send({ name: '  Deluxe  ', nights: 2 });
    expect(res.status).toBe(200);
    expect(res.body.validated).toEqual({
      body: { name: 'Deluxe', nights: 2 },
      query: { page: 3 },
      params: { id },
    });
  });

  it('applies defaults', async () => {
    const res = await request(buildApp()).post(`/things/${id}`).send({ name: 'x', nights: 1 });
    expect(res.body.validated.query).toEqual({ page: 1 });
  });

  it('strips fields the schema does not know (no mass assignment)', async () => {
    const res = await request(buildApp())
      .post(`/things/${id}`)
      .send({ name: 'x', nights: 1, role: 'admin', propertyId: 'other' });
    expect(res.body.validated.body).toEqual({ name: 'x', nights: 1 });
  });

  it('rejects an invalid body with 400 and the failing paths', async () => {
    const res = await request(buildApp()).post(`/things/${id}`).send({ name: '', nights: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    const paths = res.body.error.details.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['body.name', 'body.nights']));
  });

  it('rejects an invalid query and invalid params', async () => {
    const badQuery = await request(buildApp())
      .post(`/things/${id}?page=zero`)
      .send({ name: 'x', nights: 1 });
    expect(badQuery.status).toBe(400);
    expect(badQuery.body.error.details.issues[0].path).toBe('query.page');

    const badParams = await request(buildApp())
      .post('/things/short')
      .send({ name: 'x', nights: 1 });
    expect(badParams.status).toBe(400);
    expect(badParams.body.error.details.issues[0].path).toBe('params.id');
  });

  it('does not echo submitted values in the error', async () => {
    const res = await request(buildApp())
      .post(`/things/${id}`)
      .send({ name: 'x', nights: 'my-secret-text' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('my-secret-text');
  });

  it('treats a missing body as an invalid body', async () => {
    const res = await request(buildApp()).post(`/things/${id}`);
    expect(res.status).toBe(400);
  });
});
