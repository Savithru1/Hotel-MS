import express from 'express';
import mongoose from 'mongoose';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  HttpError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from '../shared/errors';
import { errorHandler, notFoundHandler } from './error-handler';
import { requestContext } from './request-context';

function buildApp() {
  const logger = pino({ level: 'silent' });
  const logError = vi.spyOn(logger, 'error');
  const app = express();
  app.use(requestContext());
  app.use(express.json({ limit: '1kb' }));

  app.get('/http', () => {
    throw new HttpError(418, 'teapot', 'I am a teapot', { hint: 'short and stout' });
  });
  app.get('/async', async () => {
    await Promise.resolve();
    throw notFound('Room not found');
  });
  app.get('/boom', () => {
    throw new Error('connection to db at 10.0.0.5 with password hunter2 failed');
  });
  app.get('/zod', () => {
    z.object({ name: z.string(), age: z.number() }).parse({ name: 7, age: 'secret-age-value' });
  });
  app.get('/mongoose-validation', () => {
    const error = new mongoose.Error.ValidationError();
    error.addError(
      'email',
      new mongoose.Error.ValidatorError({
        path: 'email',
        message: 'Path `email` is invalid',
        type: 'user defined',
        value: 'leaky@value.test',
      }),
    );
    throw error;
  });
  app.get('/cast', () => {
    throw new mongoose.Error.CastError('ObjectId', 'not-an-id', '_id');
  });
  app.get('/duplicate', () => {
    throw Object.assign(new Error('E11000 duplicate key ... dup key: { email: "x@y.z" }'), {
      code: 11000,
      keyPattern: { email: 1 },
      keyValue: { email: 'x@y.z' },
    });
  });
  app.post('/echo', (req, res) => {
    res.json({ got: req.body });
  });
  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return { app, logError };
}

describe('error helpers', () => {
  it.each([
    [badRequest('x'), 400, 'bad_request'],
    [unauthorized('x'), 401, 'unauthorized'],
    [forbidden('x'), 403, 'forbidden'],
    [notFound('x'), 404, 'not_found'],
    [conflict('x'), 409, 'conflict'],
  ])('builds the right HttpError', (error, status, code) => {
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
  });

  it('lets callers pick a more specific code', () => {
    expect(conflict('x', 'bad_transition').code).toBe('bad_transition');
  });
});

describe('errorHandler', () => {
  it('maps an HttpError to its status with the standard envelope and request id', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/http');
    expect(res.status).toBe(418);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'teapot', message: 'I am a teapot', details: { hint: 'short and stout' } },
      requestId: res.headers['x-request-id'],
    });
  });

  it('handles errors thrown from async handlers (Express 5)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/async');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('hides the details of unexpected errors and logs them', async () => {
    const { app, logError } = buildApp();
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'server_error', message: 'Something went wrong' });
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|10\.0\.0\.5|stack/i);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('does not log expected client errors as server errors', async () => {
    const { app, logError } = buildApp();
    await request(app).get('/http');
    await request(app).get('/nope');
    expect(logError).not.toHaveBeenCalled();
  });

  it('turns Zod errors into a 400 listing paths and messages but never the input values', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/zod');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    const paths = res.body.error.details.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'age']));
    expect(JSON.stringify(res.body)).not.toContain('secret-age-value');
  });

  it('turns mongoose validation errors into a 400 without echoing values', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/mongoose-validation');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.issues[0].path).toBe('email');
    expect(JSON.stringify(res.body)).not.toContain('leaky@value.test');
  });

  it('turns a bad ObjectId cast into a 400', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/cast');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_id');
  });

  it('turns a duplicate-key error into a 409 that names the field but not the value', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/duplicate');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('duplicate');
    expect(res.body.error.details.fields).toEqual(['email']);
    expect(JSON.stringify(res.body)).not.toContain('x@y.z');
  });

  it('answers malformed JSON with 400 bad_json', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_json');
  });

  it('answers an oversized body with 413', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/echo')
      .send({ big: 'x'.repeat(5_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('answers unknown routes with a 404 envelope', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/no/such/route');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});
