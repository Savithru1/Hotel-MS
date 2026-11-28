import type { StaffRole } from '@hospitality/constants';
import type { NotificationDto } from '@hospitality/shared-types';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { createFakeApi, staffDto } from '../test/fakeApi';
import { notification } from '../test/managerFixtures';
import { controllableSocket, mountAt } from '../test/mount';

/** An in-memory notification box that answers the four endpoints the way the server does. */
function open(role: StaffRole = 'manager', initial: NotificationDto[] = defaults()) {
  let items = [...initial];
  const api = createFakeApi(staffDto(role));
  const unread = () => items.filter((item) => item.readAt === null).length;
  api.on('GET /notifications/unread-count', () => ({ unread: unread() }));
  api.on('GET /notifications', () => ({
    data: items,
    meta: { total: items.length, page: 1, limit: 20 },
  }));
  for (const item of initial) {
    api.on(`POST /notifications/${item.id}/read`, () => {
      items = items.map((n) => (n.id === item.id ? { ...n, readAt: '2026-11-27T06:00:00Z' } : n));
      return items.find((n) => n.id === item.id);
    });
  }
  api.on('POST /notifications/read-all', () => {
    const updated = unread();
    items = items.map((n) => ({ ...n, readAt: n.readAt ?? '2026-11-27T06:00:00Z' }));
    return { updated };
  });
  const socket = controllableSocket();
  mountAt(api, '/welcome', socket.factory);
  return {
    api,
    socket,
    add: (item: NotificationDto) => {
      items = [item, ...items];
    },
  };
}

function defaults(): NotificationDto[] {
  return [
    notification({ id: 'n1', title: 'Room 204 escalated' }),
    notification({
      id: 'n2',
      type: 'new_assignment',
      title: 'New task for you',
      body: 'Room 310 needs cleaning',
      link: { kind: 'maintenance', id: 'm1' },
    }),
    notification({
      id: 'n3',
      type: 'job_failed',
      title: 'A background job failed',
      body: 'The bill sync gave up after 5 tries',
      link: { kind: 'job', id: 'j1' },
    }),
    notification({
      id: 'n4',
      title: 'Old news',
      body: 'Already seen',
      readAt: '2026-11-26T05:00:00Z',
    }),
  ];
}

const bell = () => screen.findByRole('button', { name: /^Notifications/ });
const openPanel = async () => {
  await userEvent.click(await bell());
  return within(await screen.findByRole('region', { name: 'Notifications' }));
};

describe('the notification bell', () => {
  it('shows how many notifications are unread', async () => {
    open();
    expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toBeVisible();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows no badge, and says so for screen readers, when everything is read', async () => {
    open('manager', [notification({ readAt: '2026-11-27T06:00:00Z' })]);
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeVisible();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('announces the count politely so it is read out when it changes', async () => {
    open();
    const live = await screen.findByText('3 unread notifications');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it.each(['front_desk', 'kitchen', 'housekeeping', 'maintenance', 'spa_recreation'] as const)(
    'is there for the %s role',
    async (role) => {
      open(role);
      expect(await screen.findByRole('button', { name: 'Notifications, 3 unread' })).toBeVisible();
    },
  );

  it('updates the count when a notification.created event arrives', async () => {
    const { socket, add } = open();
    await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    add(notification({ id: 'n5', title: 'Another one' }));
    act(() =>
      socket.emit('notification.created', { type: 'escalation', linkKind: 'housekeeping' }),
    );
    expect(await screen.findByRole('button', { name: 'Notifications, 4 unread' })).toBeVisible();
  });

  it('refreshes the count when the live connection comes back', async () => {
    const { socket, add } = open();
    await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    act(() => socket.fire('connect')); // first connect
    add(notification({ id: 'n5' }));
    act(() => socket.fire('disconnect', 'transport close'));
    act(() => socket.fire('connect')); // reconnect: events in between were lost
    expect(await screen.findByRole('button', { name: 'Notifications, 4 unread' })).toBeVisible();
  });

  it('opens a list with each notification, marking unread ones', async () => {
    open();
    const panel = await openPanel();
    expect(await panel.findByText('Room 204 escalated')).toBeInTheDocument();
    expect(panel.getByText('Guest waiting at the door')).toBeInTheDocument();
    expect(panel.getByText('Room 310 needs cleaning')).toBeInTheDocument();
    expect(panel.getByText('Old news')).toBeInTheDocument();
    expect(panel.getAllByRole('button', { name: /^Mark ".*" as read$/ })).toHaveLength(3);
    expect(screen.getByRole('button', { name: /^Notifications/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('closes on Escape and gives the focus back to the bell', async () => {
    open();
    await openPanel();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Notifications/ })).toHaveFocus();
  });

  it('marks one notification read and lowers the badge', async () => {
    const { api } = open();
    const panel = await openPanel();
    await userEvent.click(
      await panel.findByRole('button', { name: 'Mark "Room 204 escalated" as read' }),
    );
    await waitFor(() =>
      expect(
        api.calls.some((c) => c.method === 'POST' && c.path === '/notifications/n1/read'),
      ).toBe(true),
    );
    expect(await screen.findByRole('button', { name: 'Notifications, 2 unread' })).toBeVisible();
    expect(
      panel.queryByRole('button', { name: 'Mark "Room 204 escalated" as read' }),
    ).not.toBeInTheDocument();
  });

  it('marks everything read and removes the badge', async () => {
    const { api } = open();
    const panel = await openPanel();
    await userEvent.click(await panel.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/notifications/read-all')).toBe(true),
    );
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeVisible();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('opens the page a notification is about when the role may see it', async () => {
    open('manager');
    const panel = await openPanel();
    await userEvent.click(await panel.findByRole('button', { name: 'Room 204 escalated' }));
    expect(await screen.findByRole('heading', { name: 'Housekeeping' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('opens the audit log for a failed job, for a manager', async () => {
    open('manager');
    const panel = await openPanel();
    await userEvent.click(await panel.findByRole('button', { name: 'A background job failed' }));
    expect(await screen.findByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
  });

  it('does not link to a page the role may not open', async () => {
    const { api } = open('housekeeping');
    const panel = await openPanel();
    expect(await panel.findByText('New task for you')).toBeInTheDocument();
    // Housekeeping staff cannot open the maintenance queue or the audit log.
    expect(panel.queryByRole('button', { name: 'New task for you' })).not.toBeInTheDocument();
    expect(
      panel.queryByRole('button', { name: 'A background job failed' }),
    ).not.toBeInTheDocument();
    // But the housekeeping link works.
    expect(panel.getByRole('button', { name: 'Room 204 escalated' })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/maintenance')).toBe(false);
  });

  it('marks a notification read when it is opened', async () => {
    const { api } = open('manager');
    const panel = await openPanel();
    await userEvent.click(await panel.findByRole('button', { name: 'Room 204 escalated' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/notifications/n1/read')).toBe(true),
    );
  });

  it('says so when there is nothing', async () => {
    open('manager', []);
    const panel = await openPanel();
    expect(await panel.findByText('You have no notifications.')).toBeInTheDocument();
  });

  it('says how many are not shown when there are more than one page', async () => {
    const api = createFakeApi(staffDto('manager'));
    api.on('GET /notifications/unread-count', { unread: 57 });
    api.on('GET /notifications', {
      data: [notification()],
      meta: { total: 57, page: 1, limit: 20 },
    });
    mountAt(api, '/welcome', controllableSocket().factory);
    const panel = await openPanel();
    expect(await panel.findByText('Showing the latest 1 of 57')).toBeInTheDocument();
  });

  it('shows an error with a retry button when the list cannot be loaded', async () => {
    const api = createFakeApi(staffDto('manager'));
    let failing = true;
    api.on('GET /notifications/unread-count', { unread: 1 });
    api.on('GET /notifications', () => {
      if (failing) throw new ApiError(403, 'forbidden', 'Notifications are unavailable.');
      return { data: [notification()], meta: { total: 1, page: 1, limit: 20 } };
    });
    mountAt(api, '/welcome', controllableSocket().factory);
    const panel = await openPanel();
    expect(await panel.findByRole('alert')).toHaveTextContent('Notifications are unavailable.');
    failing = false;
    await userEvent.click(panel.getByRole('button', { name: 'Try again' }));
    expect(await panel.findByText('Room 204 escalated')).toBeInTheDocument();
  });
});
