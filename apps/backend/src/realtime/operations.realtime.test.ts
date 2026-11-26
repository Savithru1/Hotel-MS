import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StaffRole } from '@hospitality/constants';
import { pino } from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../test/db';
import { lookup, today, day, type Lookup } from '../../test/fixtures';
import { buildTestApp, type Client } from '../../test/http';
import { seedDevelopmentData, type SeededProperty } from '../modules/seed/seed';
import { eventBus } from '../shared/events/event-bus';
import { attachGateway, type Gateway, type RealtimeMessage } from './gateway';

useTestDatabase();

/**
 * End to end: a real action over HTTP changes data, the service emits on the real bus, and the
 * real gateway delivers it to exactly the right connected staff and nobody else.
 */
const t = buildTestApp();
const sockets: Socket[] = [];

let a: SeededProperty;
let b: SeededProperty;
let ids: Lookup;
let server: HttpServer;
let gateway: Gateway;
let url: string;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  ids = await lookup(await t.actAs(a.staff.front_desk?.id ?? a.id, a.id));
  server = createServer(t.app);
  gateway = await attachGateway({
    httpServer: server,
    env: t.env,
    // Same token service the app signs with, so tokens made by the test helper are accepted.
    tokens: t.tokens,
    auth: (await import('../services')).buildServices(t.env).auth,
    bus: eventBus,
    logger: pino({ level: 'silent' }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  while (sockets.length > 0) sockets.pop()?.disconnect();
});

afterAll(async () => {
  await gateway.close();
});

interface Listener {
  events: RealtimeMessage[];
}

async function listen(property: SeededProperty, role: StaffRole): Promise<Listener> {
  const staff = property.staff[role];
  const token = await t.tokens.signAccessToken({
    staffId: staff?.id ?? property.id,
    propertyId: property.id,
  });
  const events: RealtimeMessage[] = [];
  const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  socket.on('event', (message: RealtimeMessage) => events.push(message));
  await new Promise<void>((resolve, reject) => {
    socket.once('ready', () => resolve());
    socket.once('connect_error', reject);
  });
  return { events };
}

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));
const types = (listener: Listener): string[] => listener.events.map((e) => e.type);

async function everyone() {
  return {
    frontDesk: await listen(a, 'front_desk'),
    housekeeping: await listen(a, 'housekeeping'),
    maintenance: await listen(a, 'maintenance'),
    kitchen: await listen(a, 'kitchen'),
    spa: await listen(a, 'spa_recreation'),
    manager: await listen(a, 'manager'),
    otherManager: await listen(b, 'manager'),
    otherHousekeeping: await listen(b, 'housekeeping'),
  };
}

describe('live updates reach the right people', () => {
  it('a housekeeping request shows up for housekeeping, the front desk and managers only', async () => {
    const live = await everyone();
    const desk = await as(a, 'front_desk');
    const res = await desk.post('/api/v1/housekeeping', {
      roomId: ids.rooms['102'],
      type: 'room_cleaning',
    });
    expect(res.status).toBe(201);
    await settle();

    for (const heard of [live.housekeeping, live.frontDesk, live.manager]) {
      expect(types(heard)).toEqual(['housekeeping.changed']);
      expect(heard.events[0]?.data).toMatchObject({
        requestId: res.body.data.id,
        roomNumber: '102',
        status: 'new',
      });
    }
    for (const silent of [
      live.maintenance,
      live.kitchen,
      live.spa,
      live.otherManager,
      live.otherHousekeeping,
    ]) {
      expect(silent.events).toHaveLength(0);
    }
  });

  it('a maintenance issue goes to maintenance, front desk and managers, and not to housekeeping', async () => {
    const live = await everyone();
    const housekeeper = await as(a, 'housekeeping');
    const res = await housekeeper.post('/api/v1/maintenance', {
      roomId: ids.rooms['103'],
      category: 'plumbing',
      description: 'Shower drain is blocked',
    });
    expect(res.status).toBe(201);
    await settle();

    for (const heard of [live.maintenance, live.frontDesk, live.manager]) {
      expect(types(heard)).toEqual(['maintenance.changed']);
    }
    for (const silent of [
      live.housekeeping,
      live.kitchen,
      live.spa,
      live.otherManager,
      live.otherHousekeeping,
    ]) {
      expect(silent.events).toHaveLength(0);
    }
  });

  it('finishing a cleaning moves the room and tells the front desk and housekeeping the room is free', async () => {
    const desk = await as(a, 'front_desk');
    const housekeeper = await as(a, 'housekeeping');
    await desk.post(`/api/v1/rooms/${ids.rooms['104']}/status`, { status: 'cleaning' });
    const task = (
      await desk.post('/api/v1/housekeeping', { roomId: ids.rooms['104'], type: 'room_cleaning' })
    ).body.data;
    await housekeeper.post(`/api/v1/housekeeping/${task.id}/start`);

    const live = await everyone();
    await housekeeper.post(`/api/v1/housekeeping/${task.id}/complete`, {});
    await settle();

    expect(types(live.frontDesk).sort()).toEqual(['housekeeping.changed', 'room.status_changed']);
    expect(types(live.housekeeping).sort()).toEqual([
      'housekeeping.changed',
      'room.status_changed',
    ]);
    expect(types(live.manager).sort()).toEqual(['housekeeping.changed', 'room.status_changed']);
    const room = live.frontDesk.events.find((e) => e.type === 'room.status_changed');
    expect(room?.data).toMatchObject({
      roomNumber: '104',
      status: 'available',
      previous: 'cleaning',
    });
    for (const silent of [live.maintenance, live.kitchen, live.otherManager]) {
      expect(silent.events).toHaveLength(0);
    }
  });

  it('a booking check-in reaches the front desk and managers, with the room board event, and nobody else', async () => {
    const desk = await as(a, 'front_desk');
    const booking = await desk.post('/api/v1/bookings', {
      guest: { name: 'Live Guest', phone: '+917000000555' },
      roomTypeId: ids.types.Deluxe,
      roomId: ids.rooms['105'],
      checkInDate: today(),
      checkOutDate: day(1),
      adults: 1,
    });
    expect(booking.status).toBe(201);
    const live = await everyone();
    await desk.post(`/api/v1/bookings/${booking.body.data.id}/check-in`, {});
    await settle();

    expect(types(live.frontDesk).sort()).toEqual(['booking.changed', 'room.status_changed']);
    expect(types(live.manager).sort()).toEqual(['booking.changed', 'room.status_changed']);
    // Housekeeping watches room status (to see rooms to clean) but never booking details.
    expect(types(live.housekeeping)).toEqual(['room.status_changed']);
    for (const silent of [
      live.maintenance,
      live.kitchen,
      live.spa,
      live.otherManager,
      live.otherHousekeeping,
    ]) {
      expect(silent.events).toHaveLength(0);
    }
  });

  it('carries only ids and a few fields, never guest names, phone numbers or notes', async () => {
    const live = await everyone();
    const desk = await as(a, 'front_desk');
    await desk.post('/api/v1/bookings', {
      guest: { name: 'Private Person', phone: '+917000000666' },
      roomTypeId: ids.types.Standard,
      checkInDate: day(300),
      checkOutDate: day(301),
      adults: 1,
      notes: 'allergic to nuts',
    });
    await settle();
    const wire = JSON.stringify(live.frontDesk.events);
    expect(wire).not.toMatch(/Private Person|7000000666|allergic/);
  });
});
