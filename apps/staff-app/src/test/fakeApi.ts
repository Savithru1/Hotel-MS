import type { StaffDto } from '@hospitality/shared-types';
import type { StaffRole } from '@hospitality/constants';
import { vi } from 'vitest';
import { ApiError, type ApiClient, type ApiResult } from '../api/client';

export function staffDto(role: StaffRole, overrides: Partial<StaffDto> = {}): StaffDto {
  return {
    id: `id-${role}`,
    propertyId: 'p1',
    name: `Test ${role}`,
    email: `${role}@example.com`,
    role,
    departments: [role as never],
    active: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type Handler = (body: unknown, query: unknown) => unknown;

export interface FakeApi extends ApiClient {
  /** Registers the response for `METHOD /path`. Anything else answers 404. */
  on(route: string, handler: Handler | unknown): void;
  calls: { method: string; path: string; body?: unknown }[];
  signedInAs: StaffDto | null;
}

/**
 * An in-memory stand-in for the real API client. It keeps the pages honest about the paths and
 * bodies they send without needing a server.
 */
export function createFakeApi(initial: StaffDto | null = null): FakeApi {
  const handlers = new Map<string, Handler>();
  const listeners = new Set<(token: string | null) => void>();
  let token: string | null = initial ? 'token' : null;
  const calls: FakeApi['calls'] = [];

  const session = (staff: StaffDto) => ({
    tokens: { accessToken: 'token', refreshToken: 'refresh', expiresIn: 900 },
    staff,
    property: { id: 'p1', name: 'Grand Plaza', slug: 'grand-plaza' },
  });

  const api: FakeApi = {
    calls,
    signedInAs: initial,
    on(route, handler) {
      handlers.set(route, typeof handler === 'function' ? (handler as Handler) : () => handler);
    },
    async request<T>(
      method: string,
      path: string,
      options: { body?: unknown; query?: unknown } = {},
    ) {
      calls.push({ method, path, ...(options.body !== undefined ? { body: options.body } : {}) });
      const handler = handlers.get(`${method} ${path}`);
      if (!handler) throw new ApiError(404, 'not_found', `No fake for ${method} ${path}`);
      const out = await handler(options.body, options.query);
      const result = out && typeof out === 'object' && 'data' in out ? out : { data: out };
      return result as ApiResult<T>;
    },
    get(path, query) {
      return api.request('GET', path, { query });
    },
    post(path, body) {
      return api.request('POST', path, { body });
    },
    patch(path, body) {
      return api.request('PATCH', path, { body });
    },
    delete(path) {
      return api.request('DELETE', path, {});
    },
    upload(path, body) {
      return api.request('PUT', path, { body });
    },
    async getBlob(path) {
      calls.push({ method: 'GET', path });
      const handler = handlers.get(`GET ${path}`);
      if (!handler) throw new ApiError(404, 'no_image', `No fake for GET ${path}`);
      await handler(undefined, undefined);
      return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    },
    login: vi.fn(async ({ email, password }) => {
      if (password !== 'right-password') {
        throw new ApiError(401, 'invalid_credentials', 'Those details are not correct.');
      }
      const role = email.split('@')[0] as StaffRole;
      api.signedInAs = staffDto(role);
      token = 'token';
      for (const listener of listeners) listener(token);
      return session(api.signedInAs);
    }),
    restore: vi.fn(async () => (api.signedInAs ? session(api.signedInAs) : null)),
    logout: vi.fn(async () => {
      api.signedInAs = null;
      token = null;
      for (const listener of listeners) listener(null);
    }),
    changePassword: vi.fn(async () => {
      if (api.signedInAs) api.signedInAs = { ...api.signedInAs, mustChangePassword: false };
      return session(api.signedInAs as StaffDto);
    }),
    accessToken: () => token,
    onTokenChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return api;
}
