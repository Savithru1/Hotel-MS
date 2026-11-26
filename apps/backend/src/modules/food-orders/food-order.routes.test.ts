import { LATE_ORDER_MINUTES, type StaffRole } from '@hospitality/constants';
import type { FoodOrderDto, MenuItemDto } from '@hospitality/shared-types';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { addStaff, checkInGuest, lookup, type Lookup } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { eventBus, type DomainEvent } from '../../shared/events/event-bus';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { FoodOrder } from './food-order.model';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
let ids: Lookup;
let guestBooking: string;
const t = buildTestApp();

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

let manager: Client;
let kitchen: Client;
let desk: Client;
let otherManager: Client;
let otherDesk: Client;

let paneer: MenuItemDto;
let chai: MenuItemDto;
let soldOut: MenuItemDto;
let sized: MenuItemDto;

const MENU = '/api/v1/menu/items';
const ORDERS = '/api/v1/food-orders';

async function addMenuItem(client: Client, body: Record<string, unknown>): Promise<MenuItemDto> {
  const res = await client.post(MENU, body);
  expect(res.status).toBe(201);
  return res.body.data as MenuItemDto;
}

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await as(a, 'manager');
  kitchen = await as(a, 'kitchen');
  desk = await as(a, 'front_desk');
  otherManager = await as(b, 'manager');
  otherDesk = await as(b, 'front_desk');
  ids = await lookup(desk);
  guestBooking = (await checkInGuest(desk, ids, '101', 'Standard', '+917000000101')).bookingId;
  await checkInGuest(desk, ids, '102', 'Standard', '+917000000102');

  paneer = await addMenuItem(manager, {
    name: 'Paneer Butter Masala',
    category: 'Mains',
    pricePaise: 32_000,
    options: [
      { name: 'Spice level', required: true, choices: [{ label: 'Mild' }, { label: 'Hot' }] },
      {
        name: 'Add-ons',
        multiple: true,
        choices: [
          { label: 'Extra cheese', pricePaise: 3_000 },
          { label: 'Butter naan', pricePaise: 5_000 },
        ],
      },
    ],
  });
  chai = await addMenuItem(manager, { name: 'Masala Chai', category: 'Drinks', pricePaise: 8_000 });
  soldOut = await addMenuItem(manager, {
    name: 'Sold Out Biryani',
    category: 'Mains',
    pricePaise: 40_000,
    available: false,
  });
  sized = await addMenuItem(manager, {
    name: 'Fresh Lime Soda',
    category: 'Drinks',
    pricePaise: 6_000,
    options: [
      { name: 'Size', choices: [{ label: 'Regular' }, { label: 'Large', pricePaise: 2_000 }] },
    ],
  });
});

const line = (menuItem: { id: string }, extra: Record<string, unknown> = {}) => ({
  menuItemId: menuItem.id,
  quantity: 1,
  ...extra,
});
const spicy = [{ group: 'Spice level', choice: 'Hot' }];

async function place(
  items: Record<string, unknown>[] = [line(chai)],
  extra: Record<string, unknown> = {},
  client: Client = desk,
  room = '101',
): Promise<FoodOrderDto> {
  const res = await client.post(ORDERS, { roomId: ids.rooms[room], items, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as FoodOrderDto;
}

function capture(): { events: DomainEvent[]; stop: () => void } {
  const events: DomainEvent[] = [];
  const stop = eventBus.subscribe((event) => events.push(event));
  return { events, stop };
}

describe('placing an order', () => {
  it('prices every line on the server and snapshots names, options and totals', async () => {
    const order = await place(
      [
        line(paneer, {
          quantity: 2,
          selections: [...spicy, { group: 'Add-ons', choice: 'Extra cheese' }],
          note: 'no onion',
        }),
        line(chai),
      ],
      { notes: 'Call before knocking' },
    );

    expect(order).toMatchObject({
      status: 'received',
      roomNumber: '101',
      bookingId: guestBooking,
      guestName: 'In House Guest',
      notes: 'Call before knocking',
      subtotalPaise: 78_000,
      cancelReason: null,
      source: 'front_desk',
      deliveredAt: null,
    });
    expect(order.items[0]).toEqual({
      menuItemId: paneer.id,
      name: 'Paneer Butter Masala',
      quantity: 2,
      unitPricePaise: 32_000,
      options: [
        { group: 'Spice level', label: 'Hot', pricePaise: 0 },
        { group: 'Add-ons', label: 'Extra cheese', pricePaise: 3_000 },
      ],
      note: 'no onion',
      lineTotalPaise: 70_000,
    });
    expect(order.items[1]).toMatchObject({ name: 'Masala Chai', lineTotalPaise: 8_000 });
    expect(order.code).toMatch(/^FO-[A-HJKMNP-Z2-9]{6}$/);
  });

  it('adds up several add-ons and keeps the same dish on separate lines', async () => {
    const order = await place([
      line(paneer, {
        selections: [
          ...spicy,
          { group: 'Add-ons', choice: 'Extra cheese' },
          { group: 'Add-ons', choice: 'Butter naan' },
        ],
      }),
      line(paneer, { selections: [{ group: 'Spice level', choice: 'Mild' }] }),
    ]);
    expect(order.items.map((i) => i.lineTotalPaise)).toEqual([40_000, 32_000]);
    expect(order.subtotalPaise).toBe(72_000);
  });

  it('ignores any price, name, total, status or property sent by the client', async () => {
    const order = await place(
      [
        {
          ...line(chai, { quantity: 3 }),
          unitPricePaise: 1,
          lineTotalPaise: 1,
          name: 'Free tea',
        },
      ],
      {
        subtotalPaise: 1,
        status: 'delivered',
        source: 'guest',
        propertyId: b.id.toHexString(),
        bookingId: new Types.ObjectId().toHexString(),
        code: 'FO-AAAAAA',
      },
    );
    expect(order.subtotalPaise).toBe(24_000);
    expect(order.items[0]).toMatchObject({ name: 'Masala Chai', unitPricePaise: 8_000 });
    expect(order).toMatchObject({
      status: 'received',
      source: 'front_desk',
      bookingId: guestBooking,
    });
    expect(order.code).not.toBe('FO-AAAAAA');
    expect(await runWithTenant(b.id, () => FoodOrder.countDocuments({ _id: order.id }))).toBe(0);
  });

  it('gives every order its own readable code', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 8; i++) codes.add((await place()).code);
    expect(codes.size).toBe(8);
  });

  it('records the guest in the room, and that the kitchen placed it when it did', async () => {
    const order = await place([line(chai)], {}, kitchen, '102');
    expect(order).toMatchObject({ roomNumber: '102', source: 'kitchen' });
  });

  it('refuses a room with no guest checked in, an unknown room and another property’s room', async () => {
    const empty = await desk.post(ORDERS, { roomId: ids.rooms['103'], items: [line(chai)] });
    expect(empty.status).toBe(409);
    expect(empty.body.error.code).toBe('no_guest_in_room');

    const otherRoom = (await otherDesk.get('/api/v1/rooms?limit=1')).body.data[0].id;
    for (const roomId of [new Types.ObjectId().toHexString(), otherRoom]) {
      const res = await desk.post(ORDERS, { roomId, items: [line(chai)] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('unknown_room');
    }
  });

  it('refuses items that do not exist, are sold out, or belong to another property', async () => {
    const theirs = await addMenuItem(otherManager, {
      name: 'Other Hotel Special',
      category: 'Mains',
      pricePaise: 100,
    });
    for (const menuItem of [{ id: new Types.ObjectId().toHexString() }, theirs]) {
      const res = await desk.post(ORDERS, { roomId: ids.rooms['101'], items: [line(menuItem)] });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('unknown_item');
    }
    const unavailable = await desk.post(ORDERS, {
      roomId: ids.rooms['101'],
      items: [line(chai), line(soldOut)],
    });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.error.code).toBe('item_unavailable');
    expect(unavailable.body.error.message).toMatch(/Sold Out Biryani/);
  });

  it.each([
    ['a required option is missing', [] as { group: string; choice: string }[]],
    ['an option group that does not exist', [...spicy, { group: 'Sauce', choice: 'Mint' }]],
    ['a choice that does not exist', [{ group: 'Spice level', choice: 'Volcanic' }]],
    [
      'two choices in a pick-one group',
      [
        { group: 'Spice level', choice: 'Hot' },
        { group: 'Spice level', choice: 'Mild' },
      ],
    ],
    [
      'the same add-on twice',
      [
        ...spicy,
        { group: 'Add-ons', choice: 'Butter naan' },
        { group: 'Add-ons', choice: 'butter NAAN' },
      ],
    ],
  ])('refuses %s', async (_label, selections) => {
    const res = await desk.post(ORDERS, {
      roomId: ids.rooms['101'],
      items: [line(paneer, { selections })],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_selection');
  });

  it('matches option names without caring about case', async () => {
    const order = await place([
      line(paneer, { selections: [{ group: 'spice LEVEL', choice: 'hot' }] }),
    ]);
    expect(order.items[0]?.options).toEqual([
      { group: 'Spice level', label: 'Hot', pricePaise: 0 },
    ]);
  });

  it('prices a paid choice in an optional group', async () => {
    const order = await place([line(sized, { selections: [{ group: 'Size', choice: 'Large' }] })]);
    expect(order.items[0]).toMatchObject({ unitPricePaise: 6_000, lineTotalPaise: 8_000 });
  });

  it('rejects empty orders and out-of-range quantities', async () => {
    for (const bad of [
      { roomId: ids.rooms['101'], items: [] },
      { roomId: ids.rooms['101'], items: [line(chai, { quantity: 0 })] },
      { roomId: ids.rooms['101'], items: [line(chai, { quantity: 21 })] },
      { roomId: ids.rooms['101'], items: [line(chai, { quantity: 1.5 })] },
      { items: [line(chai)] },
    ]) {
      const res = await desk.post(ORDERS, bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
  });

  it('announces the order to the kitchen, front desk and managers without guest details', async () => {
    const { events, stop } = capture();
    const order = await place();
    stop();
    const announced = events.filter((e) => e.type === 'food_order.changed');
    expect(announced).toHaveLength(1);
    expect(announced[0]?.audience).toEqual({ departments: ['kitchen', 'front_desk'] });
    expect(announced[0]?.data).toEqual({
      orderId: order.id,
      orderCode: order.code,
      roomId: ids.rooms['101'],
      roomNumber: '101',
      status: 'received',
      change: 'created',
    });
    expect(events.filter((e) => e.type === 'order.delivered')).toHaveLength(0);
  });

  it('audits the order', async () => {
    const order = await place();
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'food_order.created', 'target.id': order.id }).lean(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.summary).toMatchObject({ roomId: ids.rooms['101'], subtotalPaise: 8_000 });
  });
});

describe('orders keep the price and names they were placed with', () => {
  it('does not change when the menu item is edited or deleted later', async () => {
    const throwaway = await addMenuItem(manager, {
      name: 'Short Lived Soup',
      category: 'Starters',
      pricePaise: 15_000,
    });
    const order = await place([line(throwaway, { quantity: 2 })]);
    await manager.patch(`${MENU}/${throwaway.id}`, { name: 'Renamed Soup', pricePaise: 99_000 });
    const edited = (await kitchen.get(`${ORDERS}/${order.id}`)).body.data as FoodOrderDto;
    expect(edited.items[0]).toMatchObject({
      name: 'Short Lived Soup',
      unitPricePaise: 15_000,
      lineTotalPaise: 30_000,
    });
    expect(edited.subtotalPaise).toBe(30_000);

    await manager.delete(`${MENU}/${throwaway.id}`);
    const afterDelete = (await kitchen.get(`${ORDERS}/${order.id}`)).body.data as FoodOrderDto;
    expect(afterDelete.items[0]?.name).toBe('Short Lived Soup');
    expect(afterDelete.subtotalPaise).toBe(30_000);
  });
});

describe('who may place and see orders', () => {
  it('lets front desk, kitchen and management place orders', async () => {
    for (const role of ['front_desk', 'kitchen', 'manager', 'property_admin'] as const) {
      const res = await (
        await as(a, role)
      ).post(ORDERS, {
        roomId: ids.rooms['101'],
        items: [line(chai)],
      });
      expect(res.status, role).toBe(201);
    }
  });

  it('keeps housekeeping, maintenance and spa staff out of orders entirely', async () => {
    const order = await place();
    for (const role of ['housekeeping', 'maintenance', 'spa_recreation'] as const) {
      const client = await as(a, role);
      const placed = await client.post(ORDERS, { roomId: ids.rooms['101'], items: [line(chai)] });
      expect(placed.status, role).toBe(403);
      expect((await client.get(ORDERS)).status, role).toBe(403);
      expect((await client.get(`${ORDERS}/${order.id}`)).status, role).toBe(403);
      expect((await client.get(`${ORDERS}/summary`)).status, role).toBe(403);
      expect((await client.post(`${ORDERS}/${order.id}/start`)).status, role).toBe(403);
    }
    expect((await t.anonymous.get(ORDERS)).status).toBe(401);
  });

  it('never shows or lets another property touch an order', async () => {
    const order = await place();
    expect((await otherManager.get(`${ORDERS}/${order.id}`)).status).toBe(404);
    expect((await otherManager.post(`${ORDERS}/${order.id}/start`)).status).toBe(404);
    const cancel = await otherManager.post(`${ORDERS}/${order.id}/cancel`, { reason: 'not yours' });
    expect(cancel.status).toBe(404);
    const theirList = await otherManager.get(`${ORDERS}?limit=100`);
    expect(theirList.body.data.map((o: FoodOrderDto) => o.id)).not.toContain(order.id);
    expect((await kitchen.get(`${ORDERS}/${order.id}`)).body.data.status).toBe('received');
  });

  it('answers 404 for an unknown order and 400 for a malformed id', async () => {
    expect((await kitchen.get(`${ORDERS}/0123456789abcdef01234567`)).status).toBe(404);
    expect((await kitchen.get(`${ORDERS}/nope`)).status).toBe(400);
  });
});

describe('the kitchen workflow: Received -> Preparing -> Ready -> Delivered', () => {
  it('moves one step at a time and keeps the history and timestamps', async () => {
    const order = await place();
    const preparing = await kitchen.post(`${ORDERS}/${order.id}/start`);
    expect(preparing.status).toBe(200);
    expect(preparing.body.data).toMatchObject({ status: 'preparing' });
    expect(preparing.body.data.preparingAt).toBeTruthy();

    const ready = await kitchen.post(`${ORDERS}/${order.id}/ready`);
    expect(ready.body.data).toMatchObject({ status: 'ready' });
    expect(ready.body.data.readyAt).toBeTruthy();

    const delivered = await kitchen.post(`${ORDERS}/${order.id}/deliver`);
    expect(delivered.status).toBe(200);
    expect(delivered.body.data).toMatchObject({ status: 'delivered' });
    expect(delivered.body.data.deliveredAt).toBeTruthy();

    const stored = await runWithTenant(a.id, () => FoodOrder.findOne({ _id: order.id }).lean());
    expect(stored?.history.map((h) => h.to)).toEqual([
      'received',
      'preparing',
      'ready',
      'delivered',
    ]);
  });

  it('lets the front desk mark an order delivered, but not start or finish cooking it', async () => {
    const order = await place();
    expect((await desk.post(`${ORDERS}/${order.id}/start`)).status).toBe(403);
    await kitchen.post(`${ORDERS}/${order.id}/start`);
    expect((await desk.post(`${ORDERS}/${order.id}/ready`)).status).toBe(403);
    await kitchen.post(`${ORDERS}/${order.id}/ready`);
    const delivered = await desk.post(`${ORDERS}/${order.id}/deliver`);
    expect(delivered.status).toBe(200);
    expect(delivered.body.data.status).toBe('delivered');
  });

  it('lets managers do every step', async () => {
    const order = await place();
    for (const step of ['start', 'ready', 'deliver']) {
      expect((await manager.post(`${ORDERS}/${order.id}/${step}`)).status, step).toBe(200);
    }
  });

  it.each([
    ['deliver', 'received'],
    ['ready', 'received'],
    ['deliver', 'preparing'],
    ['start', 'preparing'],
    ['start', 'ready'],
    ['ready', 'ready'],
  ] as const)('refuses to %s an order that is %s', async (step, state) => {
    const order = await place();
    if (state !== 'received') await kitchen.post(`${ORDERS}/${order.id}/start`);
    if (state === 'ready') await kitchen.post(`${ORDERS}/${order.id}/ready`);
    const res = await kitchen.post(`${ORDERS}/${order.id}/${step}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('bad_transition');
    expect((await kitchen.get(`${ORDERS}/${order.id}`)).body.data.status).toBe(state);
  });

  it('cannot move an order that is already delivered or cancelled', async () => {
    const delivered = await place();
    for (const step of ['start', 'ready', 'deliver']) {
      await kitchen.post(`${ORDERS}/${delivered.id}/${step}`);
    }
    const cancelled = await place();
    await kitchen.post(`${ORDERS}/${cancelled.id}/cancel`, { reason: 'Guest left' });
    for (const done of [delivered, cancelled]) {
      for (const step of ['start', 'ready', 'deliver']) {
        expect((await kitchen.post(`${ORDERS}/${done.id}/${step}`)).status, step).toBe(409);
      }
      const again = await kitchen.post(`${ORDERS}/${done.id}/cancel`, { reason: 'Again please' });
      expect(again.status).toBe(409);
    }
  });

  it('announces every step to the kitchen, front desk and managers', async () => {
    const order = await place();
    const { events, stop } = capture();
    await kitchen.post(`${ORDERS}/${order.id}/start`);
    await kitchen.post(`${ORDERS}/${order.id}/ready`);
    stop();
    const changes = events.filter((e) => e.type === 'food_order.changed');
    expect(changes.map((e) => (e.data as { status: string }).status)).toEqual([
      'preparing',
      'ready',
    ]);
    expect(changes.map((e) => (e.data as { change: string }).change)).toEqual(['started', 'ready']);
    for (const event of changes) {
      expect(event.audience).toEqual({ departments: ['kitchen', 'front_desk'] });
    }
  });

  it('audits every step', async () => {
    const order = await place();
    for (const step of ['start', 'ready', 'deliver']) {
      await kitchen.post(`${ORDERS}/${order.id}/${step}`);
    }
    const audits = await runWithTenant(a.id, () => AuditLog.find({ 'target.id': order.id }).lean());
    expect(audits.map((entry) => entry.action).sort()).toEqual([
      'food_order.created',
      'food_order.delivered',
      'food_order.ready',
      'food_order.started',
    ]);
  });
});

describe('cancelling', () => {
  it('needs a reason and only works before the kitchen starts', async () => {
    const order = await place();
    expect((await kitchen.post(`${ORDERS}/${order.id}/cancel`, {})).status).toBe(400);
    expect((await kitchen.post(`${ORDERS}/${order.id}/cancel`, { reason: 'x' })).status).toBe(400);

    const res = await desk.post(`${ORDERS}/${order.id}/cancel`, {
      reason: 'Guest changed their mind',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Guest changed their mind',
    });
    expect(res.body.data.cancelledAt).toBeTruthy();
  });

  it('is refused once the kitchen has started', async () => {
    const order = await place();
    await kitchen.post(`${ORDERS}/${order.id}/start`);
    const res = await desk.post(`${ORDERS}/${order.id}/cancel`, { reason: 'Too slow' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('bad_transition');
  });

  it('is not an option for staff outside the kitchen and front desk', async () => {
    const order = await place();
    const res = await (
      await as(a, 'housekeeping')
    ).post(`${ORDERS}/${order.id}/cancel`, {
      reason: 'Not my job',
    });
    expect(res.status).toBe(403);
  });

  it('is announced and audited, and never counts as delivered', async () => {
    const order = await place();
    const { events, stop } = capture();
    await desk.post(`${ORDERS}/${order.id}/cancel`, { reason: 'Guest checked out' });
    stop();
    expect(events.map((e) => e.type)).toEqual(['food_order.changed']);
    expect(events[0]?.data).toMatchObject({ status: 'cancelled', change: 'cancelled' });
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'food_order.cancelled', 'target.id': order.id }).lean(),
    );
    expect(audits[0]?.summary).toMatchObject({ reason: 'Guest checked out' });
  });
});

describe('the billing hook: order.delivered', () => {
  const toReady = async (): Promise<FoodOrderDto> => {
    const order = await place([line(chai, { quantity: 2 })]);
    await kitchen.post(`${ORDERS}/${order.id}/start`);
    await kitchen.post(`${ORDERS}/${order.id}/ready`);
    return order;
  };

  it('is emitted once, with the booking and the amount, when an order is delivered', async () => {
    const order = await toReady();
    const { events, stop } = capture();
    const res = await kitchen.post(`${ORDERS}/${order.id}/deliver`);
    stop();
    expect(res.status).toBe(200);
    const hook = events.filter((e) => e.type === 'order.delivered');
    expect(hook).toHaveLength(1);
    expect(hook[0]?.data).toEqual({
      orderId: order.id,
      bookingId: guestBooking,
      roomId: ids.rooms['101'],
      subtotalPaise: 16_000,
    });
  });

  it('is for billing only: it is not sent to any screen', async () => {
    const order = await toReady();
    const { events, stop } = capture();
    await kitchen.post(`${ORDERS}/${order.id}/deliver`);
    stop();
    const hook = events.find((e) => e.type === 'order.delivered');
    expect(hook?.audience).toEqual({ managers: false });
  });

  it('is not emitted for any other step', async () => {
    const order = await place();
    const { events, stop } = capture();
    await kitchen.post(`${ORDERS}/${order.id}/start`);
    await kitchen.post(`${ORDERS}/${order.id}/ready`);
    stop();
    expect(events.filter((e) => e.type === 'order.delivered')).toHaveLength(0);
  });

  it('is emitted exactly once when several people deliver the same order at the same moment', async () => {
    const order = await toReady();
    const second = await addStaff(t, a, 'kitchen');
    const { events, stop } = capture();
    const results = await Promise.all([
      kitchen.post(`${ORDERS}/${order.id}/deliver`),
      second.client.post(`${ORDERS}/${order.id}/deliver`),
      desk.post(`${ORDERS}/${order.id}/deliver`),
    ]);
    stop();
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(events.filter((e) => e.type === 'order.delivered')).toHaveLength(1);
    const stored = await runWithTenant(a.id, () => FoodOrder.findOne({ _id: order.id }).lean());
    expect(stored?.history.filter((h) => h.to === 'delivered')).toHaveLength(1);
  });

  it('lets only one of two simultaneous start requests win', async () => {
    const order = await place();
    const second = await addStaff(t, a, 'kitchen');
    const results = await Promise.all([
      kitchen.post(`${ORDERS}/${order.id}/start`),
      second.client.post(`${ORDERS}/${order.id}/start`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('lets a cancel and a start race, with exactly one winner', async () => {
    const order = await place();
    const results = await Promise.all([
      kitchen.post(`${ORDERS}/${order.id}/start`),
      desk.post(`${ORDERS}/${order.id}/cancel`, { reason: 'Changed mind' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('the kitchen queue', () => {
  it('lists the open orders oldest first, and filters by status, room and booking', async () => {
    const first = await place([line(chai)], {}, desk, '102');
    const second = await place([line(chai)], {}, desk, '102');
    await kitchen.post(`${ORDERS}/${second.id}/start`);

    const open = await kitchen.get(`${ORDERS}?open=true&roomId=${ids.rooms['102']}&limit=100`);
    const openIds = open.body.data.map((o: FoodOrderDto) => o.id);
    expect(openIds.indexOf(first.id)).toBeLessThan(openIds.indexOf(second.id));
    for (const order of open.body.data as FoodOrderDto[]) {
      expect(['received', 'preparing', 'ready']).toContain(order.status);
    }

    const preparing = await kitchen.get(`${ORDERS}?status=preparing&roomId=${ids.rooms['102']}`);
    const preparingIds = preparing.body.data.map((o: FoodOrderDto) => o.id);
    expect(preparingIds).toContain(second.id);
    expect(preparingIds).not.toContain(first.id);

    const byBooking = await desk.get(`${ORDERS}?bookingId=${first.bookingId}&limit=100`);
    expect(byBooking.body.data.every((o: FoodOrderDto) => o.bookingId === first.bookingId)).toBe(
      true,
    );
  });

  it('pages the list and reports the total', async () => {
    for (let i = 0; i < 3; i++) await place();
    const res = await kitchen.get(`${ORDERS}?limit=2&page=2`);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 2, limit: 2 });
    expect(res.body.meta.total).toBeGreaterThanOrEqual(3);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect((await kitchen.get(`${ORDERS}?limit=1000`)).status).toBe(400);
    expect((await kitchen.get(`${ORDERS}?status=burnt`)).status).toBe(400);
  });

  it('counts orders by status and flags the late ones', async () => {
    type Summary = { byStatus: Record<string, number>; late: number };
    const before = (await kitchen.get(`${ORDERS}/summary`)).body.data as Summary;
    const old = await place();
    await place();
    const finished = await place();
    for (const step of ['start', 'ready', 'deliver']) {
      await kitchen.post(`${ORDERS}/${finished.id}/${step}`);
    }
    await runWithTenant(a.id, () =>
      FoodOrder.updateOne(
        { _id: old.id },
        { $set: { createdAt: new Date(Date.now() - (LATE_ORDER_MINUTES + 5) * 60_000) } },
        // createdAt is immutable in mongoose; the test has to override that to age an order.
        { timestamps: false, overwriteImmutable: true },
      ),
    );
    // An old order that is already delivered is not late: there is nothing left to do.
    await runWithTenant(a.id, () =>
      FoodOrder.updateOne(
        { _id: finished.id },
        { $set: { createdAt: new Date(Date.now() - 3 * 60 * 60_000) } },
        // createdAt is immutable in mongoose; the test has to override that to age an order.
        { timestamps: false, overwriteImmutable: true },
      ),
    );

    const after = (await kitchen.get(`${ORDERS}/summary`)).body.data as Summary;
    expect(after.byStatus.received).toBe((before.byStatus.received ?? 0) + 2);
    expect(after.byStatus.delivered).toBe((before.byStatus.delivered ?? 0) + 1);
    expect(after.late).toBe(before.late + 1);
  });
});

describe('a failed audit write never leaves a half-done step', () => {
  it('rolls the delivery back, sends no billing hook, and lets a retry succeed and notify once', async () => {
    const order = await place();
    await kitchen.post(`${ORDERS}/${order.id}/start`);
    await kitchen.post(`${ORDERS}/${order.id}/ready`);

    const failing = vi
      .spyOn(AuditLog, 'create')
      .mockRejectedValueOnce(new Error('audit store down'));
    const first = capture();
    const failed = await kitchen.post(`${ORDERS}/${order.id}/deliver`);
    first.stop();
    failing.mockRestore();

    expect(failed.status).toBe(500);
    expect(first.events.filter((e) => e.type === 'order.delivered')).toHaveLength(0);
    // Not delivered, so the person can simply try again. Before this was one transaction the
    // order stayed delivered while billing was never told, and a retry only got a 409.
    expect((await kitchen.get(`${ORDERS}/${order.id}`)).body.data.status).toBe('ready');

    const second = capture();
    const retry = await kitchen.post(`${ORDERS}/${order.id}/deliver`);
    second.stop();
    expect(retry.status).toBe(200);
    expect(second.events.filter((e) => e.type === 'order.delivered')).toHaveLength(1);
  });
});

describe('the delivered list', () => {
  it('shows the most recently delivered order first, whatever time it was placed', async () => {
    const earlier = await place([line(chai)], {}, desk, '102');
    const later = await place([line(chai)], {}, desk, '102');
    for (const step of ['start', 'ready', 'deliver']) {
      await kitchen.post(`${ORDERS}/${later.id}/${step}`);
    }
    for (const step of ['start', 'ready', 'deliver']) {
      await kitchen.post(`${ORDERS}/${earlier.id}/${step}`);
    }
    const res = await kitchen.get(
      `${ORDERS}?status=delivered&roomId=${ids.rooms['102']}&limit=100`,
    );
    const delivered = res.body.data.map((o: FoodOrderDto) => o.id);
    // `earlier` was placed first but delivered last, so it leads the "latest" list.
    expect(delivered.indexOf(earlier.id)).toBeLessThan(delivered.indexOf(later.id));
  });
});

describe('the food order routes are in the API documentation', () => {
  it('lists them', async () => {
    const res = await request(t.app).get('/openapi.json');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/food-orders',
        '/api/v1/food-orders/summary',
        '/api/v1/food-orders/{id}',
        '/api/v1/food-orders/{id}/start',
        '/api/v1/food-orders/{id}/ready',
        '/api/v1/food-orders/{id}/deliver',
        '/api/v1/food-orders/{id}/cancel',
      ]),
    );
  });
});
