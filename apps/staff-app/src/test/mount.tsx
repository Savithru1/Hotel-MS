import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AppProviders, AppRoutes } from '../App';
import type { SocketLike } from '../realtime/RealtimeProvider';
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

/** Renders the real app routes at `path`, signed in through the fake API. */
export function mountAt(api: FakeApi, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api}>
        <AppRoutes createSocket={quietSocket} />
      </AppProviders>
    </MemoryRouter>,
  );
}
