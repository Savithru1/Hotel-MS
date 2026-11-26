import { LATE_ORDER_MINUTES, type StaffRole } from '@hospitality/constants';
import type { FoodOrderDto } from '@hospitality/shared-types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createFakeApi, staffDto, type FakeApi } from '../../test/fakeApi';
import { mountAt } from '../../test/mount';

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function order(overrides: Partial<FoodOrderDto> = {}): FoodOrderDto {
  return {
    id: 'o1',
    code: 'FO-7H3K9Q',
    roomId: 'r1',
    roomNumber: '204',
    bookingId: 'b1',
    guestName: 'Asha Rao',
    items: [
      {
        menuItemId: 'm1',
        name: 'Paneer Butter Masala',
        quantity: 2,
        unitPricePaise: 32_000,
        options: [{ group: 'Spice level', label: 'Hot', pricePaise: 0 }],
        note: 'no onion',
        lineTotalPaise: 64_000,
      },
    ],
    notes: 'Call before knocking',
    subtotalPaise: 64_000,
    status: 'received',
    cancelReason: null,
    source: 'front_desk',
    createdAt: minutesAgo(3),
    updatedAt: minutesAgo(3),
    preparingAt: null,
    readyAt: null,
    deliveredAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

/** Answers the order list the way the real API does: open orders, or one status. */
function serveOrders(api: FakeApi, orders: FoodOrderDto[]): void {
  api.on('GET /food-orders', (_body: unknown, query: unknown) => {
    const asked = query as { open?: boolean; status?: string };
    const items = asked.open
      ? orders.filter((o) => ['received', 'preparing', 'ready'].includes(o.status))
      : orders.filter((o) => o.status === asked.status);
    return { data: items, meta: { total: items.length, page: 1, limit: 100 } };
  });
  const open = orders.filter((o) => ['received', 'preparing', 'ready'].includes(o.status));
  const late = open.filter(
    (o) => Date.now() - Date.parse(o.createdAt) > LATE_ORDER_MINUTES * 60_000,
  );
  api.on('GET /food-orders/summary', {
    byStatus: {
      received: orders.filter((o) => o.status === 'received').length,
      preparing: orders.filter((o) => o.status === 'preparing').length,
      ready: orders.filter((o) => o.status === 'ready').length,
      delivered: orders.filter((o) => o.status === 'delivered').length,
      cancelled: orders.filter((o) => o.status === 'cancelled').length,
    },
    late: late.length,
  });
}

function open(role: StaffRole, orders: FoodOrderDto[]) {
  const api = createFakeApi(staffDto(role));
  serveOrders(api, orders);
  api.on('GET /rooms', { data: [], meta: { total: 0, page: 1, limit: 100 } });
  api.on('GET /menu/items', { data: [], meta: { total: 0, page: 1, limit: 100 } });
  mountAt(api, '/kitchen');
  return api;
}

/** Waits for the column to appear: the page shows a spinner until the order list has loaded. */
const column = async (name: string) => within(await screen.findByRole('region', { name }));

describe('the kitchen screen', () => {
  it('shows each order in the column for its status, with everything the cook needs', async () => {
    open('kitchen', [
      order(),
      order({ id: 'o2', code: 'FO-AAAAAA', roomNumber: '305', status: 'preparing' }),
      order({ id: 'o3', code: 'FO-BBBBBB', roomNumber: '102', status: 'ready' }),
      order({ id: 'o4', code: 'FO-CCCCCC', roomNumber: '110', status: 'delivered' }),
    ]);
    expect(await screen.findByRole('heading', { name: 'Kitchen' })).toBeInTheDocument();

    const received = await column('Received');
    expect(await received.findByText('Room 204')).toBeInTheDocument();
    expect(received.getByText('Asha Rao')).toBeInTheDocument();
    expect(received.getByText('FO-7H3K9Q')).toBeInTheDocument();
    expect(received.getByText(/2 ×\s+Paneer Butter Masala/)).toBeInTheDocument();
    expect(received.getByText('Hot')).toBeInTheDocument();
    expect(received.getByText(/no onion/)).toBeInTheDocument();
    expect(received.getByText(/Call before knocking/)).toBeInTheDocument();

    expect((await column('Preparing')).getByText('Room 305')).toBeInTheDocument();
    expect((await column('Ready to serve')).getByText('Room 102')).toBeInTheDocument();
    expect((await column('Delivered (latest)')).getByText('Room 110')).toBeInTheDocument();
  });

  it('says so when a column is empty', async () => {
    open('kitchen', []);
    expect(await screen.findByText('No new orders.')).toBeInTheDocument();
    expect(screen.getByText('Nothing is being prepared.')).toBeInTheDocument();
    expect(screen.getByText('Nothing is waiting to be served.')).toBeInTheDocument();
  });

  it('shows how many orders are open and how many are late', async () => {
    open('kitchen', [order(), order({ id: 'o2', createdAt: minutesAgo(LATE_ORDER_MINUTES + 10) })]);
    expect(await screen.findByText('2 open · 1 late')).toBeInTheDocument();
  });

  it('marks an open order late once it is older than the limit, and only then', async () => {
    open('kitchen', [
      order({ id: 'old', code: 'FO-OLDOLD', createdAt: minutesAgo(LATE_ORDER_MINUTES + 5) }),
      order({ id: 'new', code: 'FO-NEWNEW', createdAt: minutesAgo(2) }),
      order({
        id: 'done',
        code: 'FO-DONEDO',
        status: 'delivered',
        createdAt: minutesAgo(LATE_ORDER_MINUTES + 60),
      }),
    ]);
    await screen.findByText('FO-OLDOLD');
    const lateOrders = screen.getAllByText('Late');
    expect(lateOrders).toHaveLength(1);
    expect(screen.getByText('FO-OLDOLD').closest('li')).toContainElement(
      lateOrders[0] as HTMLElement,
    );
    expect(screen.getByText('FO-NEWNEW').closest('li')).not.toHaveTextContent('Late');
    expect(screen.getByText('FO-DONEDO').closest('li')).not.toHaveTextContent('Late');
  });

  it('lets the cook start, finish and deliver an order, sending the right requests', async () => {
    const user = userEvent.setup();
    const api = open('kitchen', [
      order({ id: 'a', code: 'FO-AAAAAA', status: 'received' }),
      order({ id: 'b', code: 'FO-BBBBBB', status: 'preparing' }),
      order({ id: 'c', code: 'FO-CCCCCC', status: 'ready' }),
    ]);
    api.on('POST /food-orders/a/start', order({ id: 'a', status: 'preparing' }));
    api.on('POST /food-orders/b/ready', order({ id: 'b', status: 'ready' }));
    api.on('POST /food-orders/c/deliver', order({ id: 'c', status: 'delivered' }));

    const received = await column('Received');
    await user.click(await received.findByRole('button', { name: 'Start preparing' }));
    const preparing = await column('Preparing');
    await user.click(await preparing.findByRole('button', { name: 'Mark ready' }));
    const ready = await column('Ready to serve');
    await user.click(await ready.findByRole('button', { name: 'Mark delivered' }));

    await waitFor(() => {
      const posts = api.calls.filter((c) => c.method === 'POST').map((c) => c.path);
      expect(posts).toEqual([
        '/food-orders/a/start',
        '/food-orders/b/ready',
        '/food-orders/c/deliver',
      ]);
    });
  });

  it('lets the front desk mark an order delivered but not cook it', async () => {
    open('front_desk', [
      order({ id: 'a', code: 'FO-AAAAAA', status: 'received' }),
      order({ id: 'b', code: 'FO-BBBBBB', status: 'preparing' }),
      order({ id: 'c', code: 'FO-CCCCCC', status: 'ready' }),
    ]);
    await screen.findByText('FO-AAAAAA');
    expect(screen.getByRole('button', { name: 'Mark delivered' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start preparing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark ready' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
  });

  it('only offers to cancel an order the kitchen has not started', async () => {
    open('kitchen', [
      order({ id: 'a', code: 'FO-AAAAAA', status: 'received' }),
      order({ id: 'b', code: 'FO-BBBBBB', status: 'preparing' }),
      order({ id: 'c', code: 'FO-CCCCCC', status: 'ready' }),
    ]);
    await screen.findByText('FO-AAAAAA');
    expect(screen.getAllByRole('button', { name: 'Cancel order' })).toHaveLength(1);
    const received = await column('Received');
    expect(received.getByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
  });

  it('needs a reason to cancel, and sends it', async () => {
    const user = userEvent.setup();
    const api = open('front_desk', [order()]);
    api.on('POST /food-orders/o1/cancel', order({ status: 'cancelled' }));

    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const confirm = await screen.findByRole('button', { name: 'Cancel this order' });
    expect(confirm).toBeDisabled();
    await user.type(
      screen.getByLabelText('Why is it being cancelled?'),
      'Guest changed their mind',
    );
    await user.click(confirm);

    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/food-orders/o1/cancel')?.body).toEqual({
        reason: 'Guest changed their mind',
      }),
    );
  });

  it('shows the server’s reason when an action is refused', async () => {
    const user = userEvent.setup();
    const api = open('kitchen', [order()]);
    api.on('POST /food-orders/o1/start', () => {
      throw new ApiError(409, 'bad_transition', 'Someone else already started this order');
    });
    await user.click(await screen.findByRole('button', { name: 'Start preparing' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else already started this order',
    );
  });

  it('says so when the delivered list cannot be loaded, instead of claiming nothing was delivered', async () => {
    const api = createFakeApi(staffDto('kitchen'));
    serveOrders(api, [order()]);
    api.on('GET /food-orders', (_body: unknown, query: unknown) => {
      if ((query as { open?: boolean }).open) {
        return { data: [order()], meta: { total: 1, page: 1, limit: 100 } };
      }
      throw new ApiError(403, 'forbidden', 'You cannot see delivered orders');
    });
    api.on('GET /rooms', { data: [], meta: { total: 0, page: 1, limit: 100 } });
    api.on('GET /menu/items', { data: [], meta: { total: 0, page: 1, limit: 100 } });
    mountAt(api, '/kitchen');
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot see delivered orders');
    expect(screen.queryByText('Nothing delivered yet.')).not.toBeInTheDocument();
  });

  it('has a sound switch that starts off and can be turned on', async () => {
    const user = userEvent.setup();
    open('kitchen', []);
    const toggle = await screen.findByRole('button', { name: 'Turn sound on' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Turn sound off' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('placing an order from the kitchen screen', () => {
  const paneer = {
    id: 'm1',
    name: 'Paneer Butter Masala',
    category: 'Main course',
    description: '',
    pricePaise: 32_000,
    available: true,
    hasImage: false,
    createdAt: '',
    updatedAt: '',
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
      {
        name: 'Add-ons',
        required: false,
        multiple: true,
        choices: [{ label: 'Extra cheese', pricePaise: 3_000 }],
      },
    ],
  };
  const chai = {
    ...paneer,
    id: 'm2',
    name: 'Masala Chai',
    category: 'Drinks',
    pricePaise: 8_000,
    options: [],
  };

  function openDesk() {
    const api = createFakeApi(staffDto('front_desk'));
    serveOrders(api, []);
    api.on('GET /rooms', {
      data: [
        {
          id: 'r1',
          number: '204',
          floor: 2,
          roomTypeId: 't',
          roomTypeName: 'Deluxe',
          status: 'occupied',
          active: true,
        },
        {
          id: 'r2',
          number: '205',
          floor: 2,
          roomTypeId: 't',
          roomTypeName: 'Deluxe',
          status: 'available',
          active: true,
        },
      ],
      meta: { total: 2, page: 1, limit: 100 },
    });
    api.on('GET /menu/items', { data: [paneer, chai], meta: { total: 2, page: 1, limit: 100 } });
    mountAt(api, '/kitchen');
    return api;
  }

  it('offers only rooms with a guest in them, and the available menu', async () => {
    const user = userEvent.setup();
    openDesk();
    await user.click(await screen.findByRole('button', { name: 'New order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a food order' });
    const room = within(dialog).getByLabelText('Room');
    expect(within(room).getByRole('option', { name: 'Room 204' })).toBeInTheDocument();
    expect(within(room).queryByRole('option', { name: 'Room 205' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Paneer Butter Masala')).toBeInTheDocument();
    expect(within(dialog).getByText('Masala Chai')).toBeInTheDocument();
  });

  it('keeps Place order disabled until there is a room and at least one item', async () => {
    const user = userEvent.setup();
    openDesk();
    await user.click(await screen.findByRole('button', { name: 'New order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a food order' });
    const place = within(dialog).getByRole('button', { name: 'Place order' });
    expect(place).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Add Masala Chai' }));
    expect(place).toBeEnabled();
  });

  it('adds the same simple item again as a higher quantity', async () => {
    const user = userEvent.setup();
    openDesk();
    await user.click(await screen.findByRole('button', { name: 'New order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a food order' });
    await user.click(within(dialog).getByRole('button', { name: 'Add Masala Chai' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add Masala Chai' }));
    expect(within(dialog).getByText(/2 ×\s+Masala Chai/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Estimated total/)).toHaveTextContent('₹160.00');
  });

  it('makes the person choose a required option before an item can be added', async () => {
    const user = userEvent.setup();
    openDesk();
    await user.click(await screen.findByRole('button', { name: 'New order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a food order' });
    await user.click(within(dialog).getByRole('button', { name: 'Add Paneer Butter Masala' }));
    const addToOrder = within(dialog).getByRole('button', { name: 'Add to order' });
    expect(addToOrder).toBeDisabled();
    expect(within(dialog).getByText(/Choose Spice level/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'Hot' }));
    expect(addToOrder).toBeEnabled();
  });

  it('sends only ids, quantities and choices, and shows the price the server worked out', async () => {
    const user = userEvent.setup();
    const api = openDesk();
    api.on('POST /food-orders', order({ id: 'new', code: 'FO-NEWONE', subtotalPaise: 35_000 }));

    await user.click(await screen.findByRole('button', { name: 'New order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a food order' });
    await user.selectOptions(within(dialog).getByLabelText('Room'), 'r1');
    await user.click(within(dialog).getByRole('button', { name: 'Add Paneer Butter Masala' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Hot' }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Extra cheese/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add to order' }));
    expect(within(dialog).getByText(/1 ×\s+Paneer Butter Masala/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Hot, Extra cheese/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Estimated total/)).toHaveTextContent('₹350.00');

    await user.type(
      within(dialog).getByLabelText('Note for the kitchen (optional)'),
      'Birthday dinner',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Place order' }));

    await waitFor(() => {
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/food-orders')?.body).toEqual(
        {
          roomId: 'r1',
          notes: 'Birthday dinner',
          items: [
            {
              menuItemId: 'm1',
              quantity: 1,
              selections: [
                { group: 'Spice level', choice: 'Hot' },
                { group: 'Add-ons', choice: 'Extra cheese' },
              ],
              note: '',
            },
          ],
        },
      );
    });
    expect(await screen.findByText('Order FO-NEWONE placed · ₹350.00')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the reason in the dialog when the server refuses the order', async () => {
    const user = userEvent.setup();
    const api = openDesk();
    api.on('POST /food-orders', () => {
      throw new ApiError(409, 'item_unavailable', 'Not available right now: Masala Chai');
    });
    await user.click(await screen.findByRole('button', { name: 'New order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a food order' });
    await user.selectOptions(within(dialog).getByLabelText('Room'), 'r1');
    await user.click(within(dialog).getByRole('button', { name: 'Add Masala Chai' }));
    await user.click(within(dialog).getByRole('button', { name: 'Place order' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Not available right now: Masala Chai',
    );
    expect(screen.getByRole('dialog', { name: 'Place a food order' })).toBeInTheDocument();
  });
});
