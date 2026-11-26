import type { Session } from '@hospitality/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, type TokenStorage } from './client';

function memoryStorage(initial: string | null = null): TokenStorage {
  let value = initial;
  return {
    read: () => value,
    write: (token) => {
      value = token;
    },
    clear: () => {
      value = null;
    },
  };
}

const session = (access: string, refresh: string): Session => ({
  tokens: { accessToken: access, refreshToken: refresh, expiresIn: 900 },
  staff: {
    id: 's1',
    propertyId: 'p1',
    name: 'Asha',
    email: 'asha@example.com',
    role: 'manager',
    departments: [],
    active: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  property: { id: 'p1', name: 'Grand Plaza', slug: 'grand-plaza' },
});

const ok = (data: unknown): Response =>
  new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fail = (status: number, code: string, message = 'No'): Response =>
  new Response(JSON.stringify({ success: false, error: { code, message } }), { status });

async function signedIn(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  const api = createApiClient({ fetchImpl, storage: memoryStorage() });
  fetchImpl.mockResolvedValueOnce(ok(session('access-1', 'refresh-1')));
  await api.login({ propertySlug: 'grand-plaza', email: 'a@b.co', password: 'pw' });
  return api;
}

describe('upload', () => {
  it('sends the file as the raw body with its own type, signed in, and unwraps the reply', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = await signedIn(fetchImpl);
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    fetchImpl.mockResolvedValueOnce(ok({ id: 'm1', hasImage: true }));
    const result = await api.upload<{ hasImage: boolean }>('/menu/items/m1/image', file);

    expect(result.data).toEqual({ id: 'm1', hasImage: true });
    const [url, init] = fetchImpl.mock.calls.at(-1) ?? [];
    expect(String(url)).toBe('/api/v1/menu/items/m1/image');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(file);
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers.Authorization).toBe('Bearer access-1');
  });

  it('turns a refusal into an ApiError with the server’s code', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = await signedIn(fetchImpl);
    fetchImpl.mockResolvedValueOnce(fail(415, 'unsupported_image', 'Send a JPEG, PNG or WebP'));
    const error = await api
      .upload('/menu/items/m1/image', new Blob(['x'], { type: 'image/png' }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 415, code: 'unsupported_image' });
  });

  it('renews an expired token once and sends the same file again', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = await signedIn(fetchImpl);
    const file = new Blob(['x'], { type: 'image/jpeg' });

    fetchImpl
      .mockResolvedValueOnce(fail(401, 'invalid_token'))
      .mockResolvedValueOnce(ok(session('access-2', 'refresh-2')))
      .mockResolvedValueOnce(ok({ hasImage: true }));
    const result = await api.upload('/menu/items/m1/image', file);

    expect(result.data).toEqual({ hasImage: true });
    const [, retry] = fetchImpl.mock.calls.at(-1) ?? [];
    expect(retry?.body).toBe(file);
    expect((retry?.headers as Record<string, string>).Authorization).toBe('Bearer access-2');
  });
});

describe('getBlob', () => {
  it('fetches a protected file with the bearer token', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = await signedIn(fetchImpl);
    fetchImpl.mockResolvedValueOnce(
      new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    const blob = await api.getBlob('/menu/items/m1/image');

    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
    const [url, init] = fetchImpl.mock.calls.at(-1) ?? [];
    expect(String(url)).toBe('/api/v1/menu/items/m1/image');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
  });

  it('turns a missing file into an ApiError and a dropped connection into a network error', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = await signedIn(fetchImpl);
    fetchImpl.mockResolvedValueOnce(fail(404, 'no_image', 'This item has no image'));
    await expect(api.getBlob('/menu/items/m1/image')).rejects.toMatchObject({
      status: 404,
      code: 'no_image',
    });
    fetchImpl.mockRejectedValueOnce(new TypeError('offline'));
    await expect(api.getBlob('/menu/items/m1/image')).rejects.toMatchObject({
      code: 'network_error',
    });
  });

  it('renews an expired token once and tries again', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = await signedIn(fetchImpl);
    fetchImpl
      .mockResolvedValueOnce(fail(401, 'invalid_token'))
      .mockResolvedValueOnce(ok(session('access-2', 'refresh-2')))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    const blob = await api.getBlob('/menu/items/m1/image');
    expect(blob.size).toBe(1);
  });
});
