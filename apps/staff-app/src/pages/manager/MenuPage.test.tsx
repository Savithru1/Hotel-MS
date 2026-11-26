import type { MenuItemDto } from '@hospitality/shared-types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeApi, staffDto } from '../../test/fakeApi';
import { mountAt } from '../../test/mount';

function item(overrides: Partial<MenuItemDto> = {}): MenuItemDto {
  return {
    id: 'm1',
    name: 'Paneer Butter Masala',
    category: 'Main course',
    description: 'Creamy tomato gravy',
    pricePaise: 32_000,
    options: [
      {
        name: 'Spice level',
        required: true,
        multiple: false,
        choices: [
          { label: 'Mild', pricePaise: 0 },
          { label: 'Hot', pricePaise: 0 },
        ],
      },
    ],
    available: true,
    hasImage: false,
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
    ...overrides,
  };
}

const chai = () =>
  item({
    id: 'm2',
    name: 'Masala Chai',
    category: 'Drinks',
    pricePaise: 8_000,
    options: [],
    description: '',
  });
const soldOut = () =>
  item({
    id: 'm3',
    name: 'Fruit Platter',
    category: 'Desserts',
    pricePaise: 20_000,
    options: [],
    available: false,
  });

function open(items: MenuItemDto[] = [item(), chai(), soldOut()]) {
  const api = createFakeApi(staffDto('manager'));
  api.on('GET /menu/items', { data: items, meta: { total: items.length, page: 1, limit: 100 } });
  mountAt(api, '/menu');
  return api;
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:fake-image');
  URL.revokeObjectURL = vi.fn();
});

describe('the menu list', () => {
  it('groups items under their category with price and availability', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'Menu' })).toBeInTheDocument();
    for (const category of ['Main course', 'Drinks', 'Desserts']) {
      expect(await screen.findByRole('heading', { name: category })).toBeInTheDocument();
    }
    const paneer = screen.getByText('Paneer Butter Masala').closest('li') as HTMLElement;
    expect(within(paneer).getByText('₹320.00')).toBeInTheDocument();
    expect(within(paneer).getByText('Creamy tomato gravy')).toBeInTheDocument();
    expect(within(paneer).getByText(/Spice level/)).toBeInTheDocument();
    const platter = screen.getByText('Fruit Platter').closest('li') as HTMLElement;
    expect(within(platter).getByText('Sold out')).toBeInTheDocument();
  });

  it('tells the manager when the list is cut off, so an item cannot silently go missing', async () => {
    const api = createFakeApi(staffDto('manager'));
    api.on('GET /menu/items', {
      data: [item(), chai()],
      meta: { total: 150, page: 1, limit: 100 },
    });
    mountAt(api, '/menu');
    expect(await screen.findByText(/Showing the first 2 of 150 items/)).toBeInTheDocument();
  });

  it('says so when the menu is empty', async () => {
    open([]);
    expect(await screen.findByText(/menu is empty/i)).toBeInTheDocument();
  });

  it('shows the photo of an item that has one, fetched with the signed-in client', async () => {
    const api = createFakeApi(staffDto('manager'));
    api.on('GET /menu/items', {
      data: [item({ hasImage: true }), chai()],
      meta: { total: 2, page: 1, limit: 100 },
    });
    api.on('GET /menu/items/m1/image', {});
    mountAt(api, '/menu');
    expect(await screen.findByAltText('Paneer Butter Masala')).toHaveAttribute(
      'src',
      'blob:fake-image',
    );
    expect(screen.queryByAltText('Masala Chai')).not.toBeInTheDocument();
    expect(api.calls.filter((c) => c.path.endsWith('/image'))).toHaveLength(1);
  });
});

describe('switching availability', () => {
  it('marks an item sold out, and available again', async () => {
    const user = userEvent.setup();
    const api = open();
    api.on('PATCH /menu/items/m2', chai());
    api.on('PATCH /menu/items/m3', soldOut());

    await user.click(await screen.findByRole('button', { name: 'Mark Masala Chai sold out' }));
    await user.click(screen.getByRole('button', { name: 'Mark Fruit Platter available' }));

    await waitFor(() => {
      const patches = api.calls.filter((c) => c.method === 'PATCH');
      expect(patches).toEqual([
        { method: 'PATCH', path: '/menu/items/m2', body: { available: false } },
        { method: 'PATCH', path: '/menu/items/m3', body: { available: true } },
      ]);
    });
  });
});

describe('adding an item', () => {
  async function openForm() {
    const user = userEvent.setup({ applyAccept: false });
    const api = open();
    await user.click(await screen.findByRole('button', { name: 'Add menu item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a menu item' });
    return { user, api, dialog };
  }

  it('sends the price in paise and the trimmed text', async () => {
    const { user, api, dialog } = await openForm();
    api.on('POST /menu/items', item({ id: 'new', name: 'Paneer Tikka' }));
    await user.type(within(dialog).getByLabelText('Name'), '  Paneer Tikka ');
    await user.type(within(dialog).getByLabelText('Category'), 'Starters');
    await user.type(within(dialog).getByLabelText('Price (₹)'), '320.50');
    await user.click(within(dialog).getByRole('button', { name: 'Save item' }));

    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/menu/items')?.body).toEqual({
        name: 'Paneer Tikka',
        category: 'Starters',
        description: '',
        pricePaise: 32_050,
        available: true,
        options: [],
      }),
    );
    expect(await screen.findByText('Added Paneer Tikka')).toBeInTheDocument();
  });

  it('explains a bad price and sends nothing', async () => {
    const { user, api, dialog } = await openForm();
    await user.type(within(dialog).getByLabelText('Name'), 'Paneer Tikka');
    await user.type(within(dialog).getByLabelText('Category'), 'Starters');
    await user.type(within(dialog).getByLabelText('Price (₹)'), 'abc');
    await user.click(within(dialog).getByRole('button', { name: 'Save item' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/price/i);
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('builds option groups with choices and extra prices', async () => {
    const { user, api, dialog } = await openForm();
    api.on('POST /menu/items', item({ id: 'new' }));
    await user.type(within(dialog).getByLabelText('Name'), 'Fresh Lime Soda');
    await user.type(within(dialog).getByLabelText('Category'), 'Drinks');
    await user.type(within(dialog).getByLabelText('Price (₹)'), '90');

    await user.click(within(dialog).getByRole('button', { name: 'Add option group' }));
    await user.type(within(dialog).getByLabelText('Option group name'), 'Size');
    await user.click(within(dialog).getByRole('button', { name: 'Add choice' }));
    await user.type(within(dialog).getByLabelText('Choice 1 name'), 'Regular');
    await user.click(within(dialog).getByRole('button', { name: 'Add choice' }));
    await user.type(within(dialog).getByLabelText('Choice 2 name'), 'Large');
    await user.type(within(dialog).getByLabelText('Choice 2 extra price (₹)'), '20');
    await user.click(within(dialog).getByLabelText('Customer must choose one'));
    await user.click(within(dialog).getByRole('button', { name: 'Save item' }));

    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
        pricePaise: 9_000,
        options: [
          {
            name: 'Size',
            required: true,
            multiple: false,
            choices: [
              { label: 'Regular', pricePaise: 0 },
              { label: 'Large', pricePaise: 2_000 },
            ],
          },
        ],
      }),
    );
  });

  it('uploads the chosen photo after the item is saved', async () => {
    const { user, api, dialog } = await openForm();
    api.on('POST /menu/items', item({ id: 'new' }));
    api.on('PUT /menu/items/new/image', item({ id: 'new', hasImage: true }));
    await user.type(within(dialog).getByLabelText('Name'), 'Paneer Tikka');
    await user.type(within(dialog).getByLabelText('Category'), 'Starters');
    await user.type(within(dialog).getByLabelText('Price (₹)'), '250');
    const file = new File([new Uint8Array([1, 2, 3])], 'tikka.png', { type: 'image/png' });
    await user.upload(within(dialog).getByLabelText('Photo (optional)'), file);
    await user.click(within(dialog).getByRole('button', { name: 'Save item' }));

    await waitFor(() => {
      const put = api.calls.find((c) => c.method === 'PUT');
      expect(put?.path).toBe('/menu/items/new/image');
      expect(put?.body).toBe(file);
    });
  });

  it('refuses a photo that is the wrong type or over 2 MB, before sending anything', async () => {
    const { user, api, dialog } = await openForm();
    const input = within(dialog).getByLabelText('Photo (optional)');
    await user.upload(input, new File(['x'], 'anim.gif', { type: 'image/gif' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /JPEG, PNG or WebP image under 2 MB/,
    );
    await user.upload(
      input,
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }),
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      /JPEG, PNG or WebP image under 2 MB/,
    );
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('editing and removing', () => {
  it('fills the form from the item and sends the changed price in paise', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const api = open();
    api.on('PATCH /menu/items/m2', chai());
    await user.click(await screen.findByRole('button', { name: 'Edit Masala Chai' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Masala Chai' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Masala Chai');
    expect(within(dialog).getByLabelText('Price (₹)')).toHaveValue('80');
    await user.clear(within(dialog).getByLabelText('Price (₹)'));
    await user.type(within(dialog).getByLabelText('Price (₹)'), '90');
    await user.click(within(dialog).getByRole('button', { name: 'Save item' }));

    await waitFor(() =>
      expect(
        api.calls.find((c) => c.method === 'PATCH' && c.path === '/menu/items/m2')?.body,
      ).toEqual({
        name: 'Masala Chai',
        category: 'Drinks',
        description: '',
        pricePaise: 9_000,
        available: true,
        options: [],
      }),
    );
  });

  it('removes the current photo when asked', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const api = createFakeApi(staffDto('manager'));
    api.on('GET /menu/items', {
      data: [item({ hasImage: true })],
      meta: { total: 1, page: 1, limit: 100 },
    });
    api.on('GET /menu/items/m1/image', {});
    api.on('PATCH /menu/items/m1', item({ hasImage: true }));
    api.on('DELETE /menu/items/m1/image', item({ hasImage: false }));
    mountAt(api, '/menu');
    await user.click(await screen.findByRole('button', { name: 'Edit Paneer Butter Masala' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Paneer Butter Masala' });
    await user.click(within(dialog).getByLabelText('Remove the current photo'));
    await user.click(within(dialog).getByRole('button', { name: 'Save item' }));
    await waitFor(() =>
      expect(
        api.calls.some((c) => c.method === 'DELETE' && c.path === '/menu/items/m1/image'),
      ).toBe(true),
    );
  });

  it('asks before removing an item, then deletes it', async () => {
    const user = userEvent.setup();
    const api = open();
    api.on('DELETE /menu/items/m2', { id: 'm2' });
    await user.click(await screen.findByRole('button', { name: 'Remove Masala Chai' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Masala Chai?' });
    expect(within(dialog).getByText(/orders already placed keep their price/i)).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Remove item' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/menu/items/m2')).toBe(
        true,
      ),
    );
  });

  it('does nothing when the person backs out of removing', async () => {
    const user = userEvent.setup();
    const api = open();
    await user.click(await screen.findByRole('button', { name: 'Remove Masala Chai' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Masala Chai?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
