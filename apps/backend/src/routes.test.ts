import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test/http';

describe('API documentation', () => {
  const { app } = buildTestApp();

  it('lists the auth and staff routes, generated from the real validation schemas', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/login',
        '/api/v1/auth/refresh',
        '/api/v1/auth/logout',
        '/api/v1/auth/me',
        '/api/v1/auth/change-password',
        '/api/v1/staff',
        '/api/v1/staff/{id}',
        '/api/v1/staff/{id}/reset-password',
      ]),
    );
    expect(res.body.paths['/api/v1/staff'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(res.body.paths['/api/v1/auth/login'].post.security).toBeUndefined();
  });
});

describe('unknown routes under the API', () => {
  it('answer 404 in the standard envelope', async () => {
    const { anonymous } = buildTestApp();
    const res = await anonymous.get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'not_found' } });
  });
});
