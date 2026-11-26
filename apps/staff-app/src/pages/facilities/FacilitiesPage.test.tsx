import type { FacilityDto } from '@hospitality/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createFakeApi, staffDto } from '../../test/fakeApi';
import { mountAt } from '../../test/mount';

function facility(overrides: Partial<FacilityDto> = {}): FacilityDto {
  return {
    id: 'f1',
    name: 'Ayurvedic Spa',
    type: 'spa',
    description: 'Massage and therapy',
    capacity: 1,
    slotMinutes: 60,
    opensAt: '09:00',
    closesAt: '18:00',
    pricePaise: 150_000,
    active: true,
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
    ...overrides,
  };
}

const pool = () =>
  facility({
    id: 'f2',
    name: 'Rooftop Pool',
    type: 'pool',
    capacity: 8,
    slotMinutes: 30,
    pricePaise: 20_000,
    description: '',
  });
const closed = () => facility({ id: 'f3', name: 'Old Sauna', active: false });

function open(items: FacilityDto[] = [facility(), pool(), closed()]) {
  const api = createFakeApi(staffDto('manager'));
  api.on('GET /facilities', { data: items, meta: { total: items.length, page: 1, limit: 100 } });
  mountAt(api, '/facilities');
  return api;
}

describe('the facilities list', () => {
  it('shows each facility with its hours, slot length, capacity and price', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'Facilities' })).toBeInTheDocument();
    const spa = (await screen.findByText('Ayurvedic Spa')).closest('li') as HTMLElement;
    expect(within(spa).getByText('Spa')).toBeInTheDocument();
    expect(within(spa).getByText('09:00–18:00')).toBeInTheDocument();
    expect(within(spa).getByText(/60 min slots/)).toBeInTheDocument();
    expect(within(spa).getByText(/one booking at a time/i)).toBeInTheDocument();
    expect(within(spa).getByText('₹1,500.00')).toBeInTheDocument();
    expect(within(spa).getByText('Massage and therapy')).toBeInTheDocument();

    const swimming = screen.getByText('Rooftop Pool').closest('li') as HTMLElement;
    expect(within(swimming).getByText(/up to 8 people/i)).toBeInTheDocument();
    const sauna = screen.getByText('Old Sauna').closest('li') as HTMLElement;
    expect(within(sauna).getByText('Closed')).toBeInTheDocument();
  });

  it('says so when there are no facilities', async () => {
    open([]);
    expect(await screen.findByText(/no facilities yet/i)).toBeInTheDocument();
  });

  it('tells the manager when the list is cut off', async () => {
    const api = createFakeApi(staffDto('manager'));
    api.on('GET /facilities', { data: [facility()], meta: { total: 150, page: 1, limit: 100 } });
    mountAt(api, '/facilities');
    expect(await screen.findByText(/Showing the first 1 of 150 facilities/)).toBeInTheDocument();
  });
});

describe('opening and closing a facility', () => {
  it('closes an open facility to new bookings, and opens a closed one again', async () => {
    const user = userEvent.setup();
    const api = open();
    api.on('PATCH /facilities/f2', pool());
    api.on('PATCH /facilities/f3', closed());
    await user.click(
      await screen.findByRole('button', { name: 'Close Rooftop Pool for bookings' }),
    );
    await user.click(screen.getByRole('button', { name: 'Open Old Sauna for bookings' }));
    await waitFor(() => {
      const patches = api.calls.filter((c) => c.method === 'PATCH');
      expect(patches).toEqual([
        { method: 'PATCH', path: '/facilities/f2', body: { active: false } },
        { method: 'PATCH', path: '/facilities/f3', body: { active: true } },
      ]);
    });
  });
});

describe('adding a facility', () => {
  async function openForm() {
    const user = userEvent.setup();
    const api = open();
    await user.click(await screen.findByRole('button', { name: 'Add facility' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a facility' });
    return { user, api, dialog };
  }

  const fill = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) => {
    await user.type(within(dialog).getByLabelText('Name'), '  Steam Room ');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'spa');
    await user.clear(within(dialog).getByLabelText('Capacity (people per slot)'));
    await user.type(within(dialog).getByLabelText('Capacity (people per slot)'), '4');
    await user.clear(within(dialog).getByLabelText('Slot length (minutes)'));
    await user.type(within(dialog).getByLabelText('Slot length (minutes)'), '45');
    fireEvent.change(within(dialog).getByLabelText('Opens at'), { target: { value: '08:00' } });
    fireEvent.change(within(dialog).getByLabelText('Closes at'), { target: { value: '20:00' } });
    await user.type(within(dialog).getByLabelText('Price per person (₹)'), '499.50');
  };

  it('sends the hours, slot length and capacity, with the price in paise and the text trimmed', async () => {
    const { user, api, dialog } = await openForm();
    api.on('POST /facilities', facility({ id: 'new', name: 'Steam Room' }));
    await fill(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Save facility' }));

    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/facilities')?.body).toEqual({
        name: 'Steam Room',
        type: 'spa',
        description: '',
        capacity: 4,
        slotMinutes: 45,
        opensAt: '08:00',
        closesAt: '20:00',
        pricePaise: 49_950,
        active: true,
      }),
    );
    expect(await screen.findByText('Added Steam Room')).toBeInTheDocument();
  });

  it('explains a bad price and sends nothing', async () => {
    const { user, api, dialog } = await openForm();
    await fill(user, dialog);
    await user.clear(within(dialog).getByLabelText('Price per person (₹)'));
    await user.type(within(dialog).getByLabelText('Price per person (₹)'), 'abc');
    await user.click(within(dialog).getByRole('button', { name: 'Save facility' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/price/i);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('explains hours that cannot hold a slot', async () => {
    const { user, api, dialog } = await openForm();
    await fill(user, dialog);
    fireEvent.change(within(dialog).getByLabelText('Closes at'), { target: { value: '08:20' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save facility' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/slot/i);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('shows the server’s reason inside the dialog when it refuses', async () => {
    const { user, api, dialog } = await openForm();
    api.on('POST /facilities', () => {
      throw new ApiError(409, 'duplicate_facility', 'A facility with that name already exists');
    });
    await fill(user, dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Save facility' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByRole('dialog', { name: 'Add a facility' })).toBeInTheDocument();
  });
});

describe('editing a facility', () => {
  it('fills the form from the facility and sends the changed price in paise', async () => {
    const user = userEvent.setup();
    const api = open();
    api.on('PATCH /facilities/f1', facility());
    await user.click(await screen.findByRole('button', { name: 'Edit Ayurvedic Spa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Ayurvedic Spa' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Ayurvedic Spa');
    expect(within(dialog).getByLabelText('Price per person (₹)')).toHaveValue('1500');
    expect(within(dialog).getByLabelText('Opens at')).toHaveValue('09:00');
    await user.clear(within(dialog).getByLabelText('Price per person (₹)'));
    await user.type(within(dialog).getByLabelText('Price per person (₹)'), '1600');
    await user.click(within(dialog).getByRole('button', { name: 'Save facility' }));

    await waitFor(() =>
      expect(
        api.calls.find((c) => c.method === 'PATCH' && c.path === '/facilities/f1')?.body,
      ).toEqual({
        name: 'Ayurvedic Spa',
        type: 'spa',
        description: 'Massage and therapy',
        capacity: 1,
        slotMinutes: 60,
        opensAt: '09:00',
        closesAt: '18:00',
        pricePaise: 160_000,
        active: true,
      }),
    );
  });

  it('shows why the hours cannot change while open bookings hold slots', async () => {
    const user = userEvent.setup();
    const api = open();
    api.on('PATCH /facilities/f1', () => {
      throw new ApiError(409, 'facility_in_use', 'Open bookings hold slots of this facility.');
    });
    await user.click(await screen.findByRole('button', { name: 'Edit Ayurvedic Spa' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Ayurvedic Spa' });
    fireEvent.change(within(dialog).getByLabelText('Closes at'), { target: { value: '17:00' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save facility' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Open bookings hold slots');
  });
});
