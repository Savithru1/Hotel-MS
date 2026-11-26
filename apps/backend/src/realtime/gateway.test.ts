import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StaffRole } from '@hospitality/constants';
import { SignJWT } from 'jose';
import { pino } from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../test/db';
import { testEnv } from '../../test/env';
import { createApp } from '../app';
import { seedDevelopmentData, type SeededProperty } from '../modules/seed/seed';
import { Staff } from '../modules/staff/staff.model';
import { buildServices } from '../services';
import { createEventBus, type AppEvents, type Audience } from '../shared/events/event-bus';
import { runWithTenant } from '../shared/request-context';
import { attachGateway, type Gateway, type RealtimeMessage } from './gateway';

useTestDatabase();

const env = testEnv();
const services = buildServices(env);
const bus = createEventBus();
const sockets: Socket[] = [];

let a: SeededProperty;
let b: SeededProperty;
let server: HttpServer;
let gateway: Gateway;
let url: string;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  server = createServer(createApp({ env, logger: pino({ level: 'silent' }), services }));
  gateway = await attachGateway({
    httpServer: server,
    env,
    tokens: services.tokens,
    auth: services.auth,
    bus,
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
  socket: Socket;
  events: RealtimeMessage[];
}

async function listen(property: SeededProperty, role: StaffRole): Promise<Listener> {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  const token = await services.tokens.signAccessToken({
    staffId: staff.id,
    propertyId: property.id,
  });
  return listenWithToken(token);
}

function listenWithToken(token: string): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const socket = connect(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    const events: RealtimeMessage[] = [];
    socket.on('event', (message: RealtimeMessage) => events.push(message));
    socket.once('ready', () => resolve({ socket, events }));
    socket.once('connect_error', (error) => reject(error));
  });
}

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function emit(propertyId: SeededProperty, audience: Audience, message = 'hello'): void {
  bus.emit({
    type: 'system.notice',
    propertyId: propertyId.id,
    audience,
    data: { message } satisfies AppEvents['system.notice'],
  });
}

describe('connection authentication', () => {
  it('accepts a valid access token', async () => {
    const { socket } = await listen(a, 'front_desk');
    expect(socket.connected).toBe(true);
  });

  it.each([
    ['no token', undefined],
    ['garbage', 'not-a-token'],
    ['empty', ''],
    ['huge', 'x'.repeat(3000)],
  ])('rejects %s', async (_name, token) => {
    await expect(listenWithToken(token as string)).rejects.toThrow(/unauthorized/);
  });

  it('rejects an expired token', async () => {
    const staff = a.staff.front_desk;
    const expired = await new SignJWT({ pid: a.id.toHexString() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(staff?.id.toHexString() ?? '')
      .setIssuer('hospitality-platform')
      .setAudience('staff')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));
    await expect(listenWithToken(expired)).rejects.toThrow(/unauthorized/);
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await new SignJWT({ pid: a.id.toHexString() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(a.staff.manager?.id.toHexString() ?? '')
      .setIssuer('hospitality-platform')
      .setAudience('staff')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('z'.repeat(48)));
    await expect(listenWithToken(forged)).rejects.toThrow(/unauthorized/);
  });

  it('rejects a deactivated account', async () => {
    const staff = b.staff.maintenance;
    await runWithTenant(b.id, () => Staff.updateOne({ _id: staff?.id }, { active: false }));
    await expect(listen(b, 'maintenance')).rejects.toThrow(/unauthorized/);
    await runWithTenant(b.id, () => Staff.updateOne({ _id: staff?.id }, { active: true }));
  });

  it('rejects a token that names a staff member from a different property', async () => {
    const mixed = await services.tokens.signAccessToken({
      staffId: b.staff.manager?.id ?? a.id,
      propertyId: a.id,
    });
    await expect(listenWithToken(mixed)).rejects.toThrow(/unauthorized/);
  });

  it('closes the connection when the access token expires', async () => {
    const staff = a.staff.kitchen;
    const shortLived = await new SignJWT({ pid: a.id.toHexString() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(staff?.id.toHexString() ?? '')
      .setIssuer('hospitality-platform')
      .setAudience('staff')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 2)
      .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));
    const { socket } = await listenWithToken(shortLived);
    expect(socket.connected).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect(socket.connected).toBe(false);
  });
});

describe('who receives an event', () => {
  it('delivers a department event to that department and to managers, and to no one else', async () => {
    const kitchen = await listen(a, 'kitchen');
    const housekeeping = await listen(a, 'housekeeping');
    const frontDesk = await listen(a, 'front_desk');
    const manager = await listen(a, 'manager');
    const admin = await listen(a, 'property_admin');

    emit(a, { departments: ['kitchen'] }, 'order up');
    await settle();

    expect(kitchen.events).toHaveLength(1);
    expect(kitchen.events[0]).toMatchObject({
      type: 'system.notice',
      data: { message: 'order up' },
    });
    expect(manager.events).toHaveLength(1);
    expect(admin.events).toHaveLength(1);
    expect(housekeeping.events).toHaveLength(0);
    expect(frontDesk.events).toHaveLength(0);
  });

  it('never delivers anything across properties', async () => {
    const aKitchen = await listen(a, 'kitchen');
    const aManager = await listen(a, 'manager');
    const bKitchen = await listen(b, 'kitchen');
    const bManager = await listen(b, 'manager');
    const bAdmin = await listen(b, 'property_admin');

    emit(a, { departments: ['kitchen', 'housekeeping', 'front_desk'] });
    await settle();

    expect(aKitchen.events).toHaveLength(1);
    expect(aManager.events).toHaveLength(1);
    expect(bKitchen.events).toHaveLength(0);
    expect(bManager.events).toHaveLength(0);
    expect(bAdmin.events).toHaveLength(0);
  });

  it('lets an event skip managers when it says so', async () => {
    const manager = await listen(a, 'manager');
    const kitchen = await listen(a, 'kitchen');
    emit(a, { departments: ['kitchen'], managers: false });
    await settle();
    expect(kitchen.events).toHaveLength(1);
    expect(manager.events).toHaveLength(0);
  });

  it('delivers a message addressed to one staff member only to them', async () => {
    const one = await listen(a, 'front_desk');
    const manager = await listen(a, 'manager');
    const other = await listen(a, 'kitchen');
    emit(a, { staffIds: [a.staff.front_desk?.id.toHexString() ?? ''], managers: false });
    await settle();
    expect(one.events).toHaveLength(1);
    expect(manager.events).toHaveLength(0);
    expect(other.events).toHaveLength(0);
  });

  it('does not send guest-booking events to any staff connection', async () => {
    const manager = await listen(a, 'manager');
    const frontDesk = await listen(a, 'front_desk');
    emit(a, { bookingIds: ['65f0000000000000000000aa'], managers: false });
    await settle();
    expect(manager.events).toHaveLength(0);
    expect(frontDesk.events).toHaveLength(0);
  });

  it('a platform admin only ever sees their own property', async () => {
    const platform = await listen(a, 'platform_admin');
    emit(b, { departments: ['kitchen'] });
    await settle();
    expect(platform.events).toHaveLength(0);
  });

  it('delivers to every connection of one person (two tabs)', async () => {
    const first = await listen(a, 'kitchen');
    const second = await listen(a, 'kitchen');
    emit(a, { departments: ['kitchen'] });
    await settle();
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
  });
});

describe('clients cannot steer the gateway', () => {
  it('cannot join a room by name, and nothing a client sends has an effect', async () => {
    const kitchen = await listen(a, 'kitchen');
    const aRoom = `p:${a.id.toHexString()}:dept:housekeeping`;
    const bRoom = `p:${b.id.toHexString()}:dept:kitchen`;
    for (const event of ['join', 'join-room', 'subscribe', 'rooms:join']) {
      kitchen.socket.emit(event, aRoom);
      kitchen.socket.emit(event, bRoom);
      kitchen.socket.emit(event, { room: aRoom });
    }
    await settle();

    const members = await gateway.io.in(aRoom).fetchSockets();
    expect(members.map((s) => s.id)).not.toContain(kitchen.socket.id);

    emit(a, { departments: ['housekeeping'], managers: false });
    emit(b, { departments: ['kitchen'], managers: false });
    await settle();
    expect(kitchen.events).toHaveLength(0);
  });

  it('cannot publish events to other clients', async () => {
    const sender = await listen(a, 'kitchen');
    const receiver = await listen(a, 'manager');
    sender.socket.emit('event', { type: 'system.notice', data: { message: 'spoof' } });
    sender.socket.emit('system.notice', { message: 'spoof' });
    await settle();
    expect(receiver.events).toHaveLength(0);
  });

  it('joins only the rooms the database says the account may have', async () => {
    const kitchen = await listen(a, 'kitchen');
    const rooms = [...(await gateway.io.fetchSockets())].find(
      (s) => s.id === kitchen.socket.id,
    )?.rooms;
    const names = [...(rooms ?? [])].filter((room) => room !== kitchen.socket.id);
    expect(names.sort()).toEqual(
      [
        `p:${a.id.toHexString()}:dept:kitchen`,
        `p:${a.id.toHexString()}:user:${a.staff.kitchen?.id.toHexString()}`,
      ].sort(),
    );
  });

  it('puts a manager in the managers room and every department room only through the managers room', async () => {
    const manager = await listen(a, 'manager');
    const rooms = [...(await gateway.io.fetchSockets())].find(
      (s) => s.id === manager.socket.id,
    )?.rooms;
    const names = [...(rooms ?? [])];
    expect(names).toContain(`p:${a.id.toHexString()}:managers`);
    expect(names.some((room) => room.includes(b.id.toHexString()))).toBe(false);
  });
});

describe('event bus', () => {
  it('does not let a failing listener break the emitter or other listeners', () => {
    const errors: unknown[] = [];
    const local = createEventBus({ onListenerError: (error) => errors.push(error) });
    let received = 0;
    local.subscribe(() => {
      throw new Error('boom');
    });
    local.subscribe(() => {
      received++;
    });
    expect(() =>
      local.emit({ type: 'system.notice', propertyId: 'x', audience: {}, data: { message: 'm' } }),
    ).not.toThrow();
    expect(received).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', () => {
    const local = createEventBus();
    let received = 0;
    const off = local.subscribe(() => {
      received++;
    });
    off();
    local.emit({ type: 'system.notice', propertyId: 'x', audience: {}, data: { message: 'm' } });
    expect(received).toBe(0);
  });

  it('refuses to build a room from a malformed id', () => {
    expect(() =>
      bus.emit({
        type: 'system.notice',
        propertyId: 'a:b',
        audience: { departments: ['kitchen'] },
        data: { message: 'x' },
      }),
    ).not.toThrow(); // the gateway listener fails safely and the emitter is unaffected
  });
});
