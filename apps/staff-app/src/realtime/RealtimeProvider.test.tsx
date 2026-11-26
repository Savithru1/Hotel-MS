import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../api/ApiContext';
import type { ApiClient } from '../api/client';
import {
  RealtimeProvider,
  useConnectionStatus,
  useRealtime,
  type RealtimeMessage,
  type SocketFactory,
  type SocketLike,
} from './RealtimeProvider';

type Handler = (...args: never[]) => void;

function fakeSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
      return socket;
    }),
    off: vi.fn((event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
      return socket;
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    io: {},
  };
  const fire = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? [])
      (handler as (...a: unknown[]) => void)(...args);
  };
  return { socket: socket as unknown as SocketLike, mocks: socket, fire };
}

const fakeApi = (overrides: Partial<ApiClient> = {}): ApiClient =>
  ({
    accessToken: () => 'token-1',
    get: vi.fn().mockResolvedValue({ data: {} }),
    ...overrides,
  }) as unknown as ApiClient;

function Probe({ onMessage }: { onMessage?: (m: RealtimeMessage) => void }) {
  const status = useConnectionStatus();
  useRealtime((message) => onMessage?.(message), ['room.status_changed']);
  return <p>status:{status}</p>;
}

function setup(api: ApiClient, factory: SocketFactory, onMessage?: (m: RealtimeMessage) => void) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiProvider client={api}>
        <RealtimeProvider createSocket={factory}>
          <Probe {...(onMessage ? { onMessage } : {})} />
        </RealtimeProvider>
      </ApiProvider>
    </QueryClientProvider>,
  );
}

describe('RealtimeProvider', () => {
  it('shows connecting, then connected, then reconnecting when the connection drops', () => {
    const { socket, fire } = fakeSocket();
    setup(fakeApi(), () => socket);
    expect(screen.getByText('status:connecting')).toBeInTheDocument();
    act(() => fire('connect'));
    expect(screen.getByText('status:connected')).toBeInTheDocument();
    act(() => fire('disconnect', 'transport close'));
    expect(screen.getByText('status:reconnecting')).toBeInTheDocument();
  });

  it('refreshes every screen after a reconnect, but not on the first connection', () => {
    const { socket, fire } = fakeSocket();
    const queries = new QueryClient();
    const invalidate = vi.spyOn(queries, 'invalidateQueries');
    render(
      <QueryClientProvider client={queries}>
        <ApiProvider client={fakeApi()}>
          <RealtimeProvider createSocket={() => socket}>
            <Probe />
          </RealtimeProvider>
        </ApiProvider>
      </QueryClientProvider>,
    );
    act(() => fire('connect'));
    expect(invalidate).not.toHaveBeenCalled();
    act(() => fire('disconnect', 'transport close'));
    act(() => fire('connect'));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('gives the socket the newest access token each time it connects', () => {
    let token = 'token-1';
    let authFn: ((cb: (data: { token: string | null }) => void) => void) | undefined;
    const { socket } = fakeSocket();
    setup(fakeApi({ accessToken: () => token }), (options) => {
      authFn = options.auth;
      return socket;
    });
    const seen: (string | null)[] = [];
    authFn?.((data) => seen.push(data.token));
    token = 'token-2';
    authFn?.((data) => seen.push(data.token));
    expect(seen).toEqual(['token-1', 'token-2']);
  });

  it('passes only the wanted event types to a listener', () => {
    const { socket, fire } = fakeSocket();
    const received: RealtimeMessage[] = [];
    setup(
      fakeApi(),
      () => socket,
      (m) => received.push(m),
    );
    act(() => {
      fire('event', { type: 'room.status_changed', data: { roomId: '1' }, at: 'now' });
      fire('event', { type: 'booking.changed', data: {}, at: 'now' });
    });
    expect(received.map((m) => m.type)).toEqual(['room.status_changed']);
  });

  it('renews the token and reconnects when the server ends the connection (token expiry)', async () => {
    vi.useFakeTimers();
    const { socket, mocks, fire } = fakeSocket();
    const api = fakeApi();
    setup(api, () => socket);
    act(() => fire('disconnect', 'io server disconnect'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(api.get).toHaveBeenCalledWith('/auth/me');
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does the same after an "unauthorized" connection error, and shows offline if renewing fails', async () => {
    vi.useFakeTimers();
    const { socket, mocks, fire } = fakeSocket();
    const api = fakeApi({
      get: vi.fn().mockRejectedValue(new Error('nope')),
    } as Partial<ApiClient>);
    setup(api, () => socket);
    act(() => fire('connect_error', new Error('unauthorized')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(screen.getByText('status:offline')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('closes the connection and stops listening when the app unmounts', () => {
    const { socket, mocks } = fakeSocket();
    const view = setup(fakeApi(), () => socket);
    view.unmount();
    expect(mocks.disconnect).toHaveBeenCalled();
    expect(mocks.off).toHaveBeenCalledWith('event', expect.any(Function));
  });
});
