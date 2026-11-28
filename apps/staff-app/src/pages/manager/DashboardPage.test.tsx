import type { OverviewDto, StaffDto } from '@hospitality/shared-types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createFakeApi, staffDto } from '../../test/fakeApi';
import { overviewFixture } from '../../test/managerFixtures';
import { controllableSocket, mountAt } from '../../test/mount';

const people = (role: 'housekeeping' | 'maintenance'): StaffDto[] => [
  staffDto(role, { id: `${role}-1`, name: 'Ravi Kumar' }),
  staffDto(role, { id: `${role}-2`, name: 'Sunita Das' }),
];

function open(overview: OverviewDto | (() => unknown) = overviewFixture()) {
  const api = createFakeApi(staffDto('manager'));
  api.on('GET /manager/overview', typeof overview === 'function' ? overview : () => overview);
  const staffQueries: unknown[] = [];
  api.on('GET /staff', (_body: unknown, query: unknown) => {
    staffQueries.push(query);
    const { role } = query as { role: 'housekeeping' | 'maintenance' };
    return { data: people(role), meta: { total: 2, page: 1, limit: 100 } };
  });
  const socket = controllableSocket();
  mountAt(api, '/manager', socket.factory);
  return { api, socket, staffQueries };
}

const overviewCalls = (api: ReturnType<typeof createFakeApi>): number =>
  api.calls.filter((call) => call.path === '/manager/overview').length;

/** The value shown next to a label inside a tile or queue panel. */
function valueOf(panel: HTMLElement, label: string): string {
  const term = within(panel).getByText(label);
  return term.nextElementSibling?.textContent ?? '';
}

describe('the manager dashboard', () => {
  it('shows a loading state while the figures are on their way', async () => {
    open(() => new Promise(() => undefined));
    expect(await screen.findByText(/Loading/)).toBeInTheDocument();
  });

  it('shows every number the API gave, exactly', async () => {
    open();
    const occupancy = await screen.findByRole('region', { name: 'Occupancy' });
    expect(within(occupancy).getByText('33.3%')).toBeInTheDocument();
    expect(occupancy).toHaveTextContent('8 of 24 sellable rooms');

    expect(
      within(screen.getByRole('region', { name: 'In house' })).getByText('7'),
    ).toBeInTheDocument();

    const arrivals = screen.getByRole('region', { name: 'Arrivals' });
    expect(valueOf(arrivals, 'Expected')).toBe('6');
    expect(valueOf(arrivals, 'Checked in')).toBe('4');

    const departures = screen.getByRole('region', { name: 'Departures' });
    expect(valueOf(departures, 'Expected')).toBe('5');
    expect(valueOf(departures, 'Checked out')).toBe('2');

    const rooms = screen.getByRole('region', { name: 'Rooms by status' });
    expect(valueOf(rooms, 'Available')).toBe('11');
    expect(valueOf(rooms, 'Occupied')).toBe('8');
    expect(valueOf(rooms, 'Cleaning')).toBe('3');
    expect(valueOf(rooms, 'Maintenance')).toBe('1');
    expect(valueOf(rooms, 'Out of service')).toBe('1');
    expect(rooms).toHaveTextContent('24 active rooms');
  });

  it('shows all four work queues with their pending, completed, escalated and urgent counts', async () => {
    open();
    await screen.findByRole('region', { name: 'Occupancy' });
    const expected: Record<string, [string, string, string, string]> = {
      'Housekeeping queue': ['5', '12', '1', '2'],
      'Maintenance queue': ['3', '4', '1', '0'],
      'Kitchen queue': ['6', '21', '0', '0'],
      'Spa and recreation queue': ['2', '7', '0', '0'],
    };
    for (const [name, [pending, done, escalated, urgent]] of Object.entries(expected)) {
      const panel = screen.getByRole('region', { name });
      expect(valueOf(panel, 'Pending')).toBe(pending);
      expect(valueOf(panel, 'Completed today')).toBe(done);
      expect(valueOf(panel, 'Escalated')).toBe(escalated);
      expect(valueOf(panel, 'Urgent')).toBe(urgent);
    }
  });

  it('says "No data" for occupancy when there are no sellable rooms, never 0%', async () => {
    open(overviewFixture({ occupancy: { occupied: 0, sellable: 0, rateBp: null } }));
    const occupancy = await screen.findByRole('region', { name: 'Occupancy' });
    expect(within(occupancy).getByText('No data')).toBeInTheDocument();
    expect(occupancy).not.toHaveTextContent('0%');
  });

  it('shows the error with a retry button, and recovers when the retry works', async () => {
    let attempts = 0;
    const { api } = open(() => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(403, 'forbidden', 'You are not allowed to see this.');
      return overviewFixture();
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('You are not allowed to see this.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Occupancy' })).toBeInTheDocument();
    expect(overviewCalls(api)).toBe(2);
  });

  it('lists escalated work, or says plainly that there is none', async () => {
    open();
    const list = await screen.findByRole('region', { name: 'Escalations' });
    expect(within(list).getByText(/Room 204/)).toBeInTheDocument();
    expect(within(list).getByText('Guest waiting at the door')).toBeInTheDocument();
    expect(within(list).getByText(/Room 310/)).toBeInTheDocument();
    expect(within(list).getByText('Water leak in the bathroom')).toBeInTheDocument();
  });

  it('shows an empty state when nothing is escalated', async () => {
    open(overviewFixture({ escalations: [] }));
    const list = await screen.findByRole('region', { name: 'Escalations' });
    expect(list).toHaveTextContent('Nothing is escalated right now.');
  });

  it('assigns a housekeeping escalation to the chosen active housekeeper, then refetches', async () => {
    const { api } = open();
    api.on('POST /housekeeping/h1/assign', { id: 'h1' });
    await userEvent.click(
      await screen.findByRole('button', { name: /Assign or reassign housekeeping task, room 204/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(
      await within(dialog).findByLabelText('Staff member'),
      'housekeeping-2',
    );
    const before = overviewCalls(api);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));

    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'POST',
        path: '/housekeeping/h1/assign',
        body: { staffId: 'housekeeping-2' },
      }),
    );
    await waitFor(() => expect(overviewCalls(api)).toBeGreaterThan(before));
    const staffCall = api.calls.find((call) => call.path === '/staff');
    expect(staffCall).toBeDefined();
  });

  it('asks the server only for active staff of the right role', async () => {
    const { api, staffQueries } = open();
    api.on('POST /maintenance/m1/assign', { id: 'm1' });
    await userEvent.click(
      await screen.findByRole('button', { name: /Assign or reassign maintenance task, room 310/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Staff member');
    expect(staffQueries).toEqual([{ role: 'maintenance', active: true, limit: 100 }]);
    await userEvent.selectOptions(within(dialog).getByLabelText('Staff member'), 'maintenance-1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'POST',
        path: '/maintenance/m1/assign',
        body: { staffId: 'maintenance-1' },
      }),
    );
  });

  it('shows the server message when the assignment is refused', async () => {
    const { api } = open();
    api.on('POST /housekeeping/h1/assign', () => {
      throw new ApiError(409, 'conflict', 'Someone else just took this task.');
    });
    await userEvent.click(
      await screen.findByRole('button', { name: /Assign or reassign housekeeping task, room 204/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(
      await within(dialog).findByLabelText('Staff member'),
      'housekeeping-1',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Someone else just took this task.',
    );
  });

  it('clears an escalation through the acknowledge endpoint', async () => {
    const { api } = open();
    api.on('POST /maintenance/m1/acknowledge', { id: 'm1' });
    await userEvent.click(
      await screen.findByRole('button', { name: /Clear escalation, maintenance task, room 310/ }),
    );
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/maintenance/m1/acknowledge')).toBe(true),
    );
  });

  it.each([
    'housekeeping.changed',
    'maintenance.changed',
    'food_order.changed',
    'room.status_changed',
  ])('refetches the figures when a live %s event arrives', async (type) => {
    const { api, socket } = open();
    await screen.findByRole('region', { name: 'Occupancy' });
    const before = overviewCalls(api);
    act(() => socket.emit(type));
    await waitFor(() => expect(overviewCalls(api)).toBeGreaterThan(before));
  });
});
