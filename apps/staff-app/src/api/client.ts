import type { ApiFailure, ApiSuccess, PageMeta, Session } from '@hospitality/shared-types';

/** A failed API call, with the stable error code from the backend envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

/** Where the long-lived refresh token is kept. Injectable so tests need no browser storage. */
export interface TokenStorage {
  read(): string | null;
  write(refreshToken: string): void;
  clear(): void;
}

export const REFRESH_TOKEN_KEY = 'hotel.staff.refreshToken';

/**
 * The refresh token lives in localStorage so a staff member stays signed in on a front-desk
 * machine across reloads. The short-lived access token is only ever held in memory. A refresh
 * token can be revoked on the server at any time (sign-out, password reset, deactivation).
 */
export const browserTokenStorage: TokenStorage = {
  read() {
    try {
      return window.localStorage.getItem(REFRESH_TOKEN_KEY);
    } catch {
      return null;
    }
  },
  write(refreshToken) {
    try {
      window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    } catch {
      // Private mode or blocked storage: the session simply will not survive a reload.
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch {
      // Nothing stored, nothing to clear.
    }
  },
};

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** Send no Authorization header (sign-in and refresh). */
  anonymous?: boolean;
}

export interface ApiResult<T> {
  data: T;
  meta?: PageMeta;
}

export interface ApiClient {
  request<T>(method: string, path: string, options?: RequestOptions): Promise<ApiResult<T>>;
  get<T>(path: string, query?: Query): Promise<ApiResult<T>>;
  post<T>(path: string, body?: unknown): Promise<ApiResult<T>>;
  patch<T>(path: string, body?: unknown): Promise<ApiResult<T>>;
  /** Signs in and keeps the new tokens. */
  login(input: { propertySlug: string; email: string; password: string }): Promise<Session>;
  /** Uses the stored refresh token to start a session, or returns null if there is none. */
  restore(): Promise<Session | null>;
  logout(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<Session>;
  /** The current access token, for the realtime connection. Null when signed out. */
  accessToken(): string | null;
  /** Called with a fresh token whenever the access token is renewed. */
  onTokenChange(listener: (token: string | null) => void): () => void;
}

export interface ApiClientOptions {
  baseUrl?: string;
  storage?: TokenStorage;
  fetchImpl?: typeof fetch;
  /** Called when the session can no longer be renewed, so the app can show the sign-in page. */
  onSessionExpired?: () => void;
}

const UNREACHABLE = 'Could not reach the server. Check your connection and try again.';

function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return `${baseUrl}/api/v1${path}${text ? `?${text}` : ''}`;
}

export function createApiClient({
  baseUrl = '',
  storage = browserTokenStorage,
  fetchImpl,
  onSessionExpired,
}: ApiClientOptions = {}): ApiClient {
  let accessToken: string | null = null;
  let refreshing: Promise<Session> | null = null;
  const listeners = new Set<(token: string | null) => void>();

  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);

  function setAccessToken(token: string | null): void {
    accessToken = token;
    for (const listener of listeners) listener(token);
  }

  async function send<T>(
    method: string,
    path: string,
    { body, query, anonymous }: RequestOptions,
  ): Promise<{ status: number; result: ApiResult<T> }> {
    let response: Response;
    try {
      response = await doFetch(buildUrl(baseUrl, path, query), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(!anonymous && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(0, 'network_error', UNREACHABLE);
    }

    let payload: ApiSuccess<T> | ApiFailure | undefined;
    try {
      payload = (await response.json()) as ApiSuccess<T> | ApiFailure;
    } catch {
      payload = undefined;
    }

    if (!response.ok || !payload || payload.success === false) {
      const failure = payload && payload.success === false ? payload : undefined;
      throw new ApiError(
        response.status,
        failure?.error.code ?? 'unexpected_response',
        failure?.error.message ?? 'The server sent an unexpected response.',
        failure?.error.details,
        failure?.requestId,
      );
    }
    return {
      status: response.status,
      result: { data: payload.data, ...(payload.meta ? { meta: payload.meta } : {}) },
    };
  }

  function startSession(session: Session): Session {
    storage.write(session.tokens.refreshToken);
    setAccessToken(session.tokens.accessToken);
    return session;
  }

  function endSession(): void {
    storage.clear();
    setAccessToken(null);
  }

  /** One refresh at a time: parallel 401s share the same call, so a token is never spent twice. */
  function refresh(): Promise<Session> {
    refreshing ??= (async () => {
      const refreshToken = storage.read();
      if (!refreshToken) {
        // Another tab signed out (it cleared the stored token). Show the sign-in page here too.
        endSession();
        onSessionExpired?.();
        throw new ApiError(401, 'no_session', 'You are not signed in.');
      }
      try {
        const { result } = await send<Session>('POST', '/auth/refresh', {
          body: { refreshToken },
          anonymous: true,
        });
        return startSession(result.data);
      } catch (error) {
        // Only a refusal ends the session. A dropped connection must not sign anyone out.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          endSession();
          onSessionExpired?.();
        }
        throw error;
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    try {
      return (await send<T>(method, path, options)).result;
    } catch (error) {
      const expired =
        error instanceof ApiError &&
        error.status === 401 &&
        error.code === 'invalid_token' &&
        !options.anonymous;
      if (!expired) throw error;
      await refresh();
      return (await send<T>(method, path, options)).result;
    }
  }

  return {
    request,
    get: (path, query) => request('GET', path, query ? { query } : {}),
    post: (path, body) => request('POST', path, body === undefined ? {} : { body }),
    patch: (path, body) => request('PATCH', path, body === undefined ? {} : { body }),

    async login(input) {
      const { result } = await send<Session>('POST', '/auth/login', {
        body: input,
        anonymous: true,
      });
      return startSession(result.data);
    },

    async restore() {
      if (!storage.read()) return null;
      try {
        return await refresh();
      } catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return null;
        throw error;
      }
    },

    async logout() {
      const refreshToken = storage.read();
      endSession();
      if (!refreshToken) return;
      try {
        await send('POST', '/auth/logout', { body: { refreshToken }, anonymous: true });
      } catch {
        // The token is already forgotten here; the server drops it when it expires.
      }
    },

    async changePassword(currentPassword, newPassword) {
      const { data } = await request<Session>('POST', '/auth/change-password', {
        body: { currentPassword, newPassword },
      });
      return startSession(data);
    },

    accessToken: () => accessToken,

    onTokenChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
