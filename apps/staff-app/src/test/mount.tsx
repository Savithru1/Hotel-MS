import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AppProviders, AppRoutes } from '../App';
import type { SocketFactory, SocketLike } from '../realtime/RealtimeProvider';
import type { FakeApi } from './fakeApi';

/** A socket that never connects and never delivers anything, so pages can be tested alone. */
export const quietSocket = (): SocketLike =>
  ({
    on: () => undefined,
    off: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
    io: {},
  }) as unknown as SocketLike;

type Handler = (...args: never[]) => void;

/** A socket the test can drive: `emit` sends a live event, `fire` raises a socket event. */
export function controllableSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const socket = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
      return socket;
    },
    off: (event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
      return socket;
    },
    connect: () => undefined,
    disconnect: () => undefined,
    io: {},
  };
  const fire = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? [])
      (handler as (...a: unknown[]) => void)(...args);
  };
  const emit = (type: string, data: Record<string, unknown> = {}): void =>
    fire('event', { type, data, at: new Date().toISOString() });
  const factory: SocketFactory = () => socket as unknown as SocketLike;
  return { factory, emit, fire };
}

/** Renders the real app routes at `path`, signed in through the fake API. */
export function mountAt(api: FakeApi, path: string, createSocket: SocketFactory = quietSocket) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api}>
        <AppRoutes createSocket={createSocket} />
      </AppProviders>
    </MemoryRouter>,
  );
}
