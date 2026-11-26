import { STAFF_ROLES } from '@hospitality/constants';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppProviders, AppRoutes } from './App';
import { ApiError } from './api/client';
import { navFor } from './auth/permissions';
import type { SocketLike } from './realtime/RealtimeProvider';
import { createFakeApi, staffDto, type FakeApi } from './test/fakeApi';

const quietSocket = (): SocketLike =>
  ({
    on: () => undefined,
    off: () => undefined,
    connect: () => undefined,
    disconnect: () => undefined,
    io: {},
  }) as unknown as SocketLike;

function mount(api: FakeApi, path = '/') {
  const emptyList = { data: [], meta: { total: 0, page: 1, limit: 25 } };
  for (const route of [
    '/rooms',
    '/housekeeping',
    '/maintenance',
    '/bookings',
    '/guests',
    '/staff',
    '/room-types',
    '/food-orders',
    '/menu/items',
  ]) {
    api.on(`GET ${route}`, emptyList);
  }
  api.on('GET /food-orders/summary', { byStatus: {}, late: 0 });
  api.on('GET /bookings/overview', {
    date: '2026-11-26',
    arrivals: [],
    departures: [],
    inHouse: [],
    counts: {
      arrivalsExpected: 0,
      arrivalsCheckedIn: 0,
      departuresExpected: 0,
      inHouse: 0,
      totalRooms: 0,
      roomsByStatus: {},
    },
  });
  api.on('GET /housekeeping/summary', { byStatus: {}, escalated: 0, urgent: 0 });
  api.on('GET /maintenance/summary', { byStatus: {}, escalated: 0, urgent: 0 });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api}>
        <AppRoutes createSocket={quietSocket} />
      </AppProviders>
    </MemoryRouter>,
  );
}

const menuLinks = (): string[] =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .queryAllByRole('link')
    .map((link) => link.textContent ?? '');

describe('signing in', () => {
  it('shows the sign-in page to a signed-out visitor, whatever page they asked for', async () => {
    mount(createFakeApi(null), '/bookings');
    expect(await screen.findByRole('heading', { name: 'Staff sign-in' })).toBeInTheDocument();
  });

  it('signs in and lands on the role’s own page', async () => {
    const user = userEvent.setup();
    mount(createFakeApi(null));
    await user.type(await screen.findByLabelText('Property'), 'grand-plaza');
    await user.type(screen.getByLabelText('Email'), 'housekeeping@example.com');
    await user.type(screen.getByLabelText('Password'), 'right-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Housekeeping' })).toBeInTheDocument();
  });

  it('shows the server’s message for a wrong password and clears the password box', async () => {
    const user = userEvent.setup();
    mount(createFakeApi(null));
    await user.type(await screen.findByLabelText('Property'), 'grand-plaza');
    await user.type(screen.getByLabelText('Email'), 'front_desk@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Those details are not correct.');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByRole('heading', { name: 'Staff sign-in' })).toBeInTheDocument();
  });

  it('resumes a stored session without asking for a password', async () => {
    mount(createFakeApi(staffDto('front_desk')), '/');
    expect(
      await screen.findByRole('heading', { name: 'Today at the front desk' }),
    ).toBeInTheDocument();
  });

  it('signs out and goes back to the sign-in page', async () => {
    const user = userEvent.setup();
    const api = createFakeApi(staffDto('front_desk'));
    mount(api);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Staff sign-in' })).toBeInTheDocument();
    expect(api.logout).toHaveBeenCalled();
    // A person signing out is not told their session "ended".
    expect(screen.queryByText(/Your session ended/)).not.toBeInTheDocument();
  });

  it('sends a person with a temporary password to change it before anything else', async () => {
    mount(createFakeApi(staffDto('front_desk', { mustChangePassword: true })), '/bookings');
    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(screen.getByText(/temporary password/i)).toBeInTheDocument();
  });

  it('checks the new password rules and that both copies match before calling the server', async () => {
    const user = userEvent.setup();
    const api = createFakeApi(staffDto('front_desk', { mustChangePassword: true }));
    mount(api);
    await user.type(await screen.findByLabelText('Current password'), 'old-password-1');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('New password again'), 'short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/must be at least 10 characters/)).toBeInTheDocument();
    expect(api.changePassword).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('New password'));
    await user.clear(screen.getByLabelText('New password again'));
    await user.type(screen.getByLabelText('New password'), 'a-good-password-1');
    await user.type(screen.getByLabelText('New password again'), 'a-different-one-2');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The two new passwords are not the same.')).toBeInTheDocument();
    expect(api.changePassword).not.toHaveBeenCalled();
  });
});

describe('what each role sees', () => {
  for (const role of STAFF_ROLES) {
    it(`${role}: the menu lists exactly the pages that role may open`, async () => {
      mount(createFakeApi(staffDto(role)));
      await screen
        .findByRole('navigation', { name: 'Main' }, { timeout: 3000 })
        .catch(() => undefined);
      await waitFor(() => expect(screen.getByRole('main')).toBeInTheDocument());
      expect(menuLinks()).toEqual(navFor(role).map((item) => item.label));
    });
  }

  it('turns a housekeeper away from the maintenance page and back to their own', async () => {
    mount(createFakeApi(staffDto('housekeeping')), '/maintenance');
    expect(await screen.findByRole('heading', { name: 'Housekeeping' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Maintenance' })).not.toBeInTheDocument();
  });

  it('turns the front desk away from staff management', async () => {
    mount(createFakeApi(staffDto('front_desk')), '/staff');
    expect(
      await screen.findByRole('heading', { name: 'Today at the front desk' }),
    ).toBeInTheDocument();
  });

  it('lets a manager open staff management', async () => {
    mount(createFakeApi(staffDto('manager')), '/staff');
    expect(await screen.findByRole('heading', { name: 'Staff' })).toBeInTheDocument();
  });

  it('lands the kitchen on the kitchen screen', async () => {
    mount(createFakeApi(staffDto('kitchen')));
    expect(await screen.findByRole('heading', { name: 'Kitchen' })).toBeInTheDocument();
    expect(menuLinks()).toEqual(['Kitchen']);
  });

  it('is honest that the spa dashboard does not exist yet', async () => {
    mount(createFakeApi(staffDto('spa_recreation')));
    expect(await screen.findByText(/has not been built yet/)).toBeInTheDocument();
    expect(menuLinks()).toEqual([]);
  });

  it('turns the front desk away from the menu editor, but lets a manager in', async () => {
    mount(createFakeApi(staffDto('front_desk')), '/menu');
    expect(
      await screen.findByRole('heading', { name: 'Today at the front desk' }),
    ).toBeInTheDocument();
  });

  it('lets a manager open the menu editor', async () => {
    mount(createFakeApi(staffDto('manager')), '/menu');
    expect(await screen.findByRole('heading', { name: 'Menu' })).toBeInTheDocument();
  });

  it('sends any unknown address to the person’s home page', async () => {
    mount(createFakeApi(staffDto('maintenance')), '/not-a-page');
    expect(await screen.findByRole('heading', { name: 'Maintenance' })).toBeInTheDocument();
  });
});

describe('a work queue', () => {
  const openQueue =
    (item: unknown) =>
    (_body: unknown, query: unknown): unknown => {
      const asked = query as { open?: boolean } | undefined;
      return asked?.open
        ? { data: [item], meta: { total: 1, page: 1, limit: 100 } }
        : { data: [], meta: { total: 0, page: 1, limit: 10 } };
    };

  const task = (status: string, assignedTo: { id: string; name: string } | null = null) => ({
    id: 't1',
    type: 'room_cleaning',
    roomId: 'r1',
    roomNumber: '204',
    bookingId: null,
    guestName: null,
    notes: '',
    priority: 'normal',
    status,
    assignedTo,
    escalated: false,
    escalationReason: null,
    source: 'front_desk',
    createdAt: '2026-11-26T06:00:00.000Z',
    completedAt: null,
  });

  it('lets a housekeeper start a task, and sends the right request', async () => {
    const user = userEvent.setup();
    const api = createFakeApi(staffDto('housekeeping'));
    mount(api, '/housekeeping');
    api.on('GET /housekeeping', openQueue(task('new')));
    api.on('POST /housekeeping/t1/start', task('in_progress'));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(api.calls).toContainEqual({ method: 'POST', path: '/housekeeping/t1/start' }),
    );
  });

  it('hides Start from a housekeeper when the task belongs to a colleague, but not from a manager', async () => {
    const other = { id: 'someone-else', name: 'Colleague' };
    const mine = createFakeApi(staffDto('housekeeping'));
    mount(mine, '/housekeeping');
    mine.on('GET /housekeeping', openQueue({ ...task('new'), assignedTo: other }));
    expect(await screen.findByText('Assigned to Colleague')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });

  it('still offers a manager Start on a colleague’s task', async () => {
    const api = createFakeApi(staffDto('manager'));
    mount(api, '/housekeeping');
    api.on(
      'GET /housekeeping',
      openQueue({ ...task('new'), assignedTo: { id: 'x', name: 'Colleague' } }),
    );
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('does not offer the front desk a Start button, only escalate and cancel', async () => {
    const api = createFakeApi(staffDto('front_desk'));
    mount(api, '/housekeeping');
    api.on('GET /housekeeping', openQueue(task('new')));
    expect(await screen.findByRole('button', { name: 'Escalate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });

  it('shows the server’s reason when an action is refused', async () => {
    const user = userEvent.setup();
    const api = createFakeApi(staffDto('housekeeping'));
    mount(api, '/housekeeping');
    api.on('GET /housekeeping', openQueue(task('new')));
    api.on('POST /housekeeping/t1/start', () => {
      throw new ApiError(409, 'bad_transition', 'Someone else started this task first.');
    });
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else started this task first.',
    );
  });
});
