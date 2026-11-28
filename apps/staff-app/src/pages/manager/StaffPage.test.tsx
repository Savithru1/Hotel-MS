import type { StaffRole } from '@hospitality/constants';
import type { StaffDto } from '@hospitality/shared-types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createFakeApi, staffDto } from '../../test/fakeApi';
import { mountAt } from '../../test/mount';

const asha = staffDto('front_desk', {
  id: 'st-asha',
  name: 'Asha Rao',
  email: 'asha@example.com',
  departments: ['front_desk'],
});
const ravi = staffDto('housekeeping', { id: 'st-ravi', name: 'Ravi Kumar', email: 'ravi@x.com' });
const peer = staffDto('manager', { id: 'st-peer', name: 'Peer Manager', email: 'peer@x.com' });
const boss = staffDto('property_admin', { id: 'st-boss', name: 'The Owner', email: 'boss@x.com' });

function open(actor: StaffRole = 'manager', people: StaffDto[] = [asha, ravi, peer, boss]) {
  const api = createFakeApi(staffDto(actor, { id: 'me', name: 'Me Myself' }));
  api.on('GET /staff', {
    data: [staffDto(actor, { id: 'me', name: 'Me Myself' }), ...people],
    meta: { total: people.length + 1, page: 1, limit: 100 },
  });
  mountAt(api, '/staff');
  return api;
}

const rowOf = async (name: string) =>
  within((await screen.findByText(name)).closest('tr') as HTMLElement);

async function openEditor(name: string) {
  const row = await rowOf(name);
  await userEvent.click(row.getByRole('button', { name: `Edit ${name}` }));
  return within(await screen.findByRole('dialog', { name: `Edit ${name}` }));
}

describe('editing a staff member', () => {
  it('offers Edit only for people the actor outranks', async () => {
    open('manager');
    expect((await rowOf('Asha Rao')).getByRole('button', { name: 'Edit Asha Rao' })).toBeVisible();
    expect(
      (await rowOf('Peer Manager')).queryByRole('button', { name: /Edit/ }),
    ).not.toBeInTheDocument();
    expect(
      (await rowOf('The Owner')).queryByRole('button', { name: /Edit/ }),
    ).not.toBeInTheDocument();
    expect(
      (await rowOf('Me Myself (you)')).queryByRole('button', { name: /Edit/ }),
    ).not.toBeInTheDocument();
  });

  it('sends only the name when only the name was changed, then closes and reloads the list', async () => {
    const api = open();
    api.on('PATCH /staff/st-asha', { ...asha, name: 'Asha Nair' });
    const dialog = await openEditor('Asha Rao');
    const name = dialog.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Asha Nair');
    await userEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'PATCH',
        path: '/staff/st-asha',
        body: { name: 'Asha Nair' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.calls.filter((c) => c.method === 'GET' && c.path === '/staff').length).toBe(2);
  });

  it('keeps Save switched off until something changes', async () => {
    open();
    const dialog = await openEditor('Asha Rao');
    expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await userEvent.type(dialog.getByLabelText('Name'), 'x');
    expect(dialog.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('offers a manager only roles below manager', async () => {
    open('manager');
    const dialog = await openEditor('Asha Rao');
    const roles = within(dialog.getByLabelText('Role'))
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(roles).toEqual([
      'front_desk',
      'kitchen',
      'housekeeping',
      'maintenance',
      'spa_recreation',
    ]);
  });

  it('lets an owner hand out the manager role, but never the owner role', async () => {
    open('property_admin');
    const dialog = await openEditor('Asha Rao');
    const roles = within(dialog.getByLabelText('Role'))
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(roles).toContain('manager');
    expect(roles).not.toContain('property_admin');
    expect(roles).not.toContain('platform_admin');
  });

  it('sends only the role when only the role was changed', async () => {
    const api = open();
    api.on('PATCH /staff/st-asha', asha);
    const dialog = await openEditor('Asha Rao');
    await userEvent.selectOptions(dialog.getByLabelText('Role'), 'kitchen');
    await userEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'PATCH',
        path: '/staff/st-asha',
        body: { role: 'kitchen' },
      }),
    );
  });

  it('sends the departments when they were edited, and insists on at least one', async () => {
    const api = open();
    api.on('PATCH /staff/st-asha', asha);
    const dialog = await openEditor('Asha Rao');
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Kitchen' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.calls).toContainEqual({
        method: 'PATCH',
        path: '/staff/st-asha',
        body: { departments: ['front_desk', 'kitchen'] },
      }),
    );

    const again = await openEditor('Asha Rao');
    await userEvent.click(again.getByRole('checkbox', { name: 'Front desk' }));
    expect(again.getByText('Pick at least one department.')).toBeInTheDocument();
    expect(again.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('does not show departments for a management role, which always covers every department', async () => {
    open('property_admin');
    const dialog = await openEditor('Peer Manager');
    expect(dialog.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(dialog.getByText(/cover every department/)).toBeInTheDocument();
  });

  it('shows the server message when the change is refused with a 409, and stays open', async () => {
    const api = open();
    api.on('PATCH /staff/st-asha', () => {
      throw new ApiError(409, 'conflict', 'Someone changed this account a moment ago. Reload it.');
    });
    const dialog = await openEditor('Asha Rao');
    await userEvent.type(dialog.getByLabelText('Name'), 'x');
    await userEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Someone changed this account a moment ago. Reload it.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the server message when the role is refused with a 403', async () => {
    const api = open();
    api.on('PATCH /staff/st-asha', () => {
      throw new ApiError(403, 'role_too_high', 'You cannot give a role at or above your own');
    });
    const dialog = await openEditor('Asha Rao');
    await userEvent.selectOptions(dialog.getByLabelText('Role'), 'kitchen');
    await userEvent.click(dialog.getByRole('button', { name: 'Save changes' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'You cannot give a role at or above your own',
    );
  });
});
