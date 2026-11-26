import type { Session } from '@hospitality/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, type TokenStorage } from './client';

function memoryStorage(initial: string | null = null): TokenStorage & { value: string | null } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (token: string) => {
      store.value = token;
    },
    clear: () => {
      store.value = null;
    },
  };
  return store;
}

const session = (access: string, refresh: string): Session => ({
  tokens: { accessToken: access, refreshToken: refresh, expiresIn: 900 },
  staff: {
    id: 's1',
    propertyId: 'p1',
    name: 'Asha',
    email: 'asha@example.com',
    role: 'front_desk',
    departments: ['front_desk'],
    active: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  property: { id: 'p1', name: 'Grand Plaza', slug: 'grand-plaza' },
});

const ok = (data: unknown, meta?: unknown): Response =>
  new Response(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }), { status: 200 });
const fail = (status: number, code: string, message = 'No'): Response =>
  new Response(JSON.stringify({ success: false, error: { code, message }, requestId: 'r1' }), {
    status,
  });

describe('requests', () => {
  it('unwraps the envelope, sends the bearer token and builds the query string', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ok([{ id: 1 }], { total: 1, page: 1, limit: 25 }),
    );
    const storage = memoryStorage();
    const api = createApiClient({ fetchImpl, storage });
    fetchImpl.mockResolvedValueOnce(ok(session('access-1', 'refresh-1')));
    await api.login({ propertySlug: 'grand-plaza', email: 'a@b.co', password: 'pw' });

    const result = await api.get<{ id: number }[]>('/rooms', {
      floor: 2,
      q: '',
      empty: undefined,
      open: true,
    });
    expect(result.data).toEqual([{ id: 1 }]);
    expect(result.meta).toMatchObject({ total: 1 });
    const [url, init] = fetchImpl.mock.calls.at(-1) ?? [];
    expect(String(url)).toBe('/api/v1/rooms?floor=2&open=true');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
  });

  it('turns a failure envelope into an ApiError with its code and request id', async () => {
    const api = createApiClient({
      fetchImpl: async () => fail(409, 'room_unavailable', 'Taken'),
      storage: memoryStorage(),
    });
    const error = await api.post('/bookings', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'room_unavailable',
      message: 'Taken',
      requestId: 'r1',
    });
  });

  it('reports a dropped connection as a network error, not a sign-out', async () => {
    const storage = memoryStorage('refresh-1');
    const onSessionExpired = vi.fn();
    const api = createApiClient({
      fetchImpl: async () => Promise.reject(new TypeError('offline')),
      storage,
      onSessionExpired,
    });
    await expect(api.get('/rooms')).rejects.toMatchObject({ code: 'network_error' });
    expect(storage.value).toBe('refresh-1');
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('copes with a response that is not the envelope at all', async () => {
    const api = createApiClient({
      fetchImpl: async () => new Response('<html>oops</html>', { status: 502 }),
      storage: memoryStorage(),
    });
    await expect(api.get('/rooms')).rejects.toMatchObject({
      status: 502,
      code: 'unexpected_response',
    });
  });
});

describe('sign-in and sign-out', () => {
  it('keeps only the refresh token in storage and the access token in memory', async () => {
    const storage = memoryStorage();
    const api = createApiClient({
      fetchImpl: async () => ok(session('access-1', 'refresh-1')),
      storage,
    });
    await api.login({ propertySlug: 'grand-plaza', email: 'a@b.co', password: 'pw' });
    expect(storage.value).toBe('refresh-1');
    expect(api.accessToken()).toBe('access-1');
    expect(JSON.stringify(window.localStorage)).not.toContain('access-1');
  });

  it('forgets everything on logout and tells the server to revoke', async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn<typeof fetch>(async () => ok(session('access-1', 'refresh-1')));
    const api = createApiClient({ fetchImpl, storage });
    await api.login({ propertySlug: 'grand-plaza', email: 'a@b.co', password: 'pw' });
    fetchImpl.mockResolvedValueOnce(ok({ loggedOut: true }));
    await api.logout();
    expect(storage.value).toBeNull();
    expect(api.accessToken()).toBeNull();
    const [url, init] = fetchImpl.mock.calls.at(-1) ?? [];
    expect(String(url)).toBe('/api/v1/auth/logout');
    expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'refresh-1' });
  });

  it('still signs out locally when the server cannot be reached', async () => {
    const storage = memoryStorage('refresh-1');
    const api = createApiClient({
      fetchImpl: async () => Promise.reject(new TypeError('offline')),
      storage,
    });
    await api.logout();
    expect(storage.value).toBeNull();
  });

  it('restores a session from the stored refresh token', async () => {
    const storage = memoryStorage('refresh-1');
    const api = createApiClient({
      fetchImpl: async () => ok(session('access-2', 'refresh-2')),
      storage,
    });
    const restored = await api.restore();
    expect(restored?.staff.name).toBe('Asha');
    expect(storage.value).toBe('refresh-2');
  });

  it('has nothing to restore without a stored token, and drops a refused one', async () => {
    expect(
      await createApiClient({
        fetchImpl: async () => ok(null),
        storage: memoryStorage(),
      }).restore(),
    ).toBeNull();
    const storage = memoryStorage('stale');
    const api = createApiClient({
      fetchImpl: async () => fail(401, 'invalid_refresh_token'),
      storage,
    });
    expect(await api.restore()).toBeNull();
    expect(storage.value).toBeNull();
  });

  it('tells the app when another tab has signed out (no stored token) instead of failing quietly', async () => {
    const onSessionExpired = vi.fn();
    const storage = memoryStorage(null);
    const fetchImpl = vi.fn<typeof fetch>(async () => fail(401, 'invalid_token'));
    const api = createApiClient({ fetchImpl, storage, onSessionExpired });
    await expect(api.get('/rooms')).rejects.toMatchObject({ code: 'no_session' });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('does not drop the stored token when the restore fails because the network is down', async () => {
    const storage = memoryStorage('refresh-1');
    const api = createApiClient({
      fetchImpl: async () => Promise.reject(new TypeError('offline')),
      storage,
    });
    await expect(api.restore()).rejects.toMatchObject({ code: 'network_error' });
    expect(storage.value).toBe('refresh-1');
  });
});

describe('automatic token refresh', () => {
  function setup() {
    const storage = memoryStorage('refresh-1');
    const calls: string[] = [];
    let refreshCount = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method} ${url}`);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (url.endsWith('/auth/refresh')) {
        refreshCount++;
        return ok(session(`fresh-${refreshCount}`, `refresh-${refreshCount + 1}`));
      }
      return auth === 'Bearer fresh-1' ? ok({ ok: true }) : fail(401, 'invalid_token');
    });
    const onSessionExpired = vi.fn();
    return {
      api: createApiClient({ fetchImpl, storage, onSessionExpired }),
      storage,
      calls,
      onSessionExpired,
      refreshes: () => refreshCount,
    };
  }

  it('refreshes once on an expired access token and retries the request', async () => {
    const { api, calls, storage } = setup();
    const result = await api.get('/rooms');
    expect(result.data).toEqual({ ok: true });
    expect(calls).toEqual(['GET /api/v1/rooms', 'POST /api/v1/auth/refresh', 'GET /api/v1/rooms']);
    expect(storage.value).toBe('refresh-2');
  });

  it('shares one refresh between many simultaneous requests (a token is never spent twice)', async () => {
    const { api, refreshes } = setup();
    const results = await Promise.all([api.get('/a'), api.get('/b'), api.get('/c'), api.get('/d')]);
    expect(results).toHaveLength(4);
    expect(refreshes()).toBe(1);
  });

  it('signs out and tells the app when the refresh is refused', async () => {
    const storage = memoryStorage('refresh-1');
    const onSessionExpired = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/auth/refresh')
        ? fail(401, 'refresh_reused')
        : fail(401, 'invalid_token'),
    );
    const api = createApiClient({ fetchImpl, storage, onSessionExpired });
    await expect(api.get('/rooms')).rejects.toMatchObject({ status: 401 });
    expect(storage.value).toBeNull();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('does not try to refresh for other 401s (wrong password) or for anonymous calls', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => fail(401, 'invalid_credentials'));
    const api = createApiClient({ fetchImpl, storage: memoryStorage('refresh-1') });
    await expect(
      api.login({ propertySlug: 'x', email: 'a@b.co', password: 'bad' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after one retry instead of looping', async () => {
    const storage = memoryStorage('refresh-1');
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/auth/refresh')
        ? ok(session('fresh', 'refresh-2'))
        : fail(401, 'invalid_token'),
    );
    const api = createApiClient({ fetchImpl, storage });
    await expect(api.get('/rooms')).rejects.toMatchObject({ code: 'invalid_token' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('tells listeners when the access token changes', async () => {
    const seen: (string | null)[] = [];
    const api = createApiClient({
      fetchImpl: async () => ok(session('access-9', 'refresh-9')),
      storage: memoryStorage(),
    });
    const off = api.onTokenChange((token) => seen.push(token));
    await api.login({ propertySlug: 'x', email: 'a@b.co', password: 'pw' });
    await api.logout();
    off();
    expect(seen).toEqual(['access-9', null]);
  });
});
