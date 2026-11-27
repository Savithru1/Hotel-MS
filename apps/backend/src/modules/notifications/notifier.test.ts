import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StaffRole } from '@hospitality/constants';
import { Types } from 'mongoose';
import { pino } from 'pino';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { addStaff, lookup, type Lookup } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { attachGateway, type Gateway, type RealtimeMessage } from '../../realtime/gateway';
import { createEventBus, eventBus } from '../../shared/events/event-bus';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Notification } from './notification.model';
import { startNotifier, type Notifier } from './notifier';
import { createNotificationService } from './notification.service';

useTestDatabase();

/**
 * End to end: a real action over HTTP, the real bus, the notifier, the notification service and
 * the real gateway, checked against who is actually connected.
 */
const t = buildTestApp();
const sockets: Socket[] = [];

let a: SeededProperty;
let b: SeededProperty;
let ids: Lookup;
let server: HttpServer;
let gateway: Gateway;
let notifier: Notifier;
let url: string;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  const services = (await import('../../services')).buildServices(t.env);
  ids = await lookup(await t.actAs(a.staff.front_desk?.id ?? a.id, a.id));
  server = createServer(t.app);
  gateway = await attachGateway({
    httpServer: server,
    env: t.env,
    tokens: t.tokens,
    auth: services.auth,
    bus: eventBus,
    logger: pino({ level: 'silent' }),
  });
  notifier = startNotifier({
    bus: eventBus,
    notifications: createNotificationService(eventBus),
    logger: pino({ level: 'silent' }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  while (sockets.length > 0) sockets.pop()?.disconnect();
});

afterAll(async () => {
  notifier.stop();
  await gateway.close();
});

interface Listener {
  /** Only the `notification.created` messages this connection received. */
  heard: RealtimeMessage[];
}

async function listen(property: SeededProperty, role: StaffRole): Promise<Listener> {
  const staff = property.staff[role];
  const token = await t.tokens.signAccessToken({
    staffId: staff?.id ?? property.id,
    propertyId: property.id,
  });
  const heard: RealtimeMessage[] = [];
  const socket = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  socket.on('event', (message: RealtimeMessage) => {
    if (message.type === 'notification.created') heard.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('ready', () => resolve());
    socket.once('connect_error', reject);
  });
  return { heard };
}

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

/** Waits for the notifier to finish, then for the socket messages to arrive. */
async function settle(): Promise<void> {
  await notifier.idle();
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const storedFor = (property: SeededProperty, staffId: Types.ObjectId, linkId: string) =>
  runWithTenant(property.id, () =>
    Notification.find({ 'recipient.id': staffId, 'link.id': linkId }).lean(),
  );

async function everyone() {
  return {
    manager: await listen(a, 'manager'),
    admin: await listen(a, 'property_admin'),
    housekeeping: await listen(a, 'housekeeping'),
    frontDesk: await listen(a, 'front_desk'),
    maintenance: await listen(a, 'maintenance'),
    otherManager: await listen(b, 'manager'),
    otherAdmin: await listen(b, 'property_admin'),
  };
}

describe('escalations', () => {
  it('reach the managers of that property live, and nobody else', async () => {
    const live = await everyone();
    const desk = await as(a, 'front_desk');
    const task = (
      await desk.post('/api/v1/housekeeping', { roomId: ids.rooms['102'], type: 'room_cleaning' })
    ).body.data.id as string;
    await settle();
    expect(live.manager.heard).toHaveLength(0);

    const housekeeper = await as(a, 'housekeeping');
    expect(
      (await housekeeper.post(`/api/v1/housekeeping/${task}/escalate`, { reason: 'Guest waiting' }))
        .status,
    ).toBe(200);
    await settle();

    for (const heard of [live.manager, live.admin]) {
      expect(heard.heard).toHaveLength(1);
      expect(heard.heard[0]?.data).toEqual({ type: 'escalation', linkKind: 'housekeeping' });
    }
    for (const silent of [
      live.housekeeping,
      live.frontDesk,
      live.maintenance,
      live.otherManager,
      live.otherAdmin,
    ]) {
      expect(silent.heard).toHaveLength(0);
    }

    // Stored for the two managers of property A only; the escalating housekeeper gets none.
    const stored = await runWithTenant(a.id, () => Notification.find({ 'link.id': task }).lean());
    expect(stored.map((n) => n.recipient.id.toHexString()).sort()).toEqual(
      [a.staff.manager?.id, a.staff.property_admin?.id].map((id) => id?.toHexString()).sort(),
    );
    expect(stored.every((n) => n.type === 'escalation' && n.readAt === null)).toBe(true);
    expect(await runWithTenant(b.id, () => Notification.countDocuments({ 'link.id': task }))).toBe(
      0,
    );
  });

  it('does not notify the manager who raised the escalation themselves', async () => {
    const live = await everyone();
    const manager = await as(a, 'manager');
    const issue = (
      await manager.post('/api/v1/maintenance', {
        roomId: ids.rooms['103'],
        category: 'electrical',
        description: 'Light flickers',
      })
    ).body.data.id as string;
    await manager.post(`/api/v1/maintenance/${issue}/escalate`, { reason: 'Getting worse' });
    await settle();

    expect(live.manager.heard).toHaveLength(0);
    expect(live.admin.heard).toHaveLength(1);
    expect(await storedFor(a, a.staff.manager?.id as Types.ObjectId, issue)).toHaveLength(0);
  });
});

describe('assignments', () => {
  it('reach only the person who was given the task', async () => {
    const other = await addStaff(t, a, 'housekeeping');
    const otherLive = await (async () => {
      const token = await t.tokens.signAccessToken({ staffId: other.id, propertyId: a.id });
      const heard: RealtimeMessage[] = [];
      const socket = connect(url, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);
      socket.on('event', (m: RealtimeMessage) => {
        if (m.type === 'notification.created') heard.push(m);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('ready', () => resolve());
        socket.once('connect_error', reject);
      });
      return { heard };
    })();
    const live = await everyone();

    const desk = await as(a, 'front_desk');
    const task = (
      await desk.post('/api/v1/housekeeping', { roomId: ids.rooms['104'], type: 'room_cleaning' })
    ).body.data.id as string;
    const manager = await as(a, 'manager');
    await manager.post(`/api/v1/housekeeping/${task}/assign`, { staffId: other.id.toHexString() });
    await settle();

    expect(otherLive.heard).toHaveLength(1);
    expect(otherLive.heard[0]?.data).toEqual({ type: 'new_assignment', linkKind: 'housekeeping' });
    for (const silent of Object.values(live)) expect(silent.heard).toHaveLength(0);
    const stored = await runWithTenant(a.id, () => Notification.find({ 'link.id': task }).lean());
    expect(stored).toHaveLength(1);
    expect(stored[0]?.recipient.id.toHexString()).toBe(other.id.toHexString());
  });

  it('go to the new person when a manager reassigns work in progress', async () => {
    const first = a.staff.housekeeping?.id as Types.ObjectId;
    const second = await addStaff(t, a, 'housekeeping');
    const desk = await as(a, 'front_desk');
    const housekeeper = await as(a, 'housekeeping');
    const manager = await as(a, 'manager');
    const task = (
      await desk.post('/api/v1/housekeeping', { roomId: ids.rooms['105'], type: 'room_cleaning' })
    ).body.data.id as string;
    await housekeeper.post(`/api/v1/housekeeping/${task}/start`);
    await settle();

    await manager.post(`/api/v1/housekeeping/${task}/assign`, { staffId: second.id.toHexString() });
    await settle();

    expect(await storedFor(a, second.id, task)).toHaveLength(1);
    expect(await storedFor(a, first, task)).toHaveLength(0);
  });

  it('are not sent to a technician who took the issue for themselves', async () => {
    const housekeeper = await as(a, 'housekeeping');
    const technician = await as(a, 'maintenance');
    const issue = (
      await housekeeper.post('/api/v1/maintenance', {
        roomId: ids.rooms['201'],
        category: 'other',
        description: 'Broken chair',
      })
    ).body.data.id as string;
    const mine = a.staff.maintenance?.id.toHexString();
    expect(
      (await technician.post(`/api/v1/maintenance/${issue}/assign`, { staffId: mine })).status,
    ).toBe(200);
    await settle();
    expect(await storedFor(a, a.staff.maintenance?.id as Types.ObjectId, issue)).toHaveLength(0);
  });
});

describe('urgent maintenance', () => {
  it('notifies managers when an urgent or high issue is created, but not for a medium one', async () => {
    const live = await everyone();
    const housekeeper = await as(a, 'housekeeping');
    const make = async (priority: string): Promise<string> =>
      (
        await housekeeper.post('/api/v1/maintenance', {
          roomId: ids.rooms['202'],
          category: 'plumbing',
          description: `Priority ${priority}`,
          priority,
        })
      ).body.data.id as string;

    const medium = await make('medium');
    await settle();
    expect(live.manager.heard).toHaveLength(0);

    const urgent = await make('urgent');
    const high = await make('high');
    await settle();
    expect(live.manager.heard).toHaveLength(2);
    expect(live.admin.heard).toHaveLength(2);
    expect(live.manager.heard[0]?.data).toEqual({ type: 'urgent_issue', linkKind: 'maintenance' });
    for (const silent of [live.housekeeping, live.frontDesk, live.otherManager]) {
      expect(silent.heard).toHaveLength(0);
    }
    expect(await storedFor(a, a.staff.manager?.id as Types.ObjectId, medium)).toHaveLength(0);
    expect(await storedFor(a, a.staff.manager?.id as Types.ObjectId, urgent)).toHaveLength(1);
    expect(await storedFor(a, a.staff.manager?.id as Types.ObjectId, high)).toHaveLength(1);
  });
});

describe('failures', () => {
  it('are logged and never reach the code that raised the event', async () => {
    const bus = createEventBus();
    const logger = { error: vi.fn() };
    const local = startNotifier({
      bus,
      notifications: {
        notify: () => Promise.reject(new Error('database down')),
      } as never,
      logger: logger as never,
    });
    expect(() =>
      bus.emit({
        type: 'housekeeping.changed',
        propertyId: a.id,
        audience: {},
        data: {
          requestId: new Types.ObjectId().toHexString(),
          roomId: new Types.ObjectId().toHexString(),
          roomNumber: '101',
          status: 'new',
          change: 'escalated',
          escalated: true,
          assignedTo: null,
        },
      }),
    ).not.toThrow();
    await local.idle();
    expect(logger.error).toHaveBeenCalledTimes(1);
    local.stop();
  });

  it('ignore events that have nothing to notify', async () => {
    const bus = createEventBus();
    const notify = vi.fn();
    const local = startNotifier({
      bus,
      notifications: { notify } as never,
      logger: pino({ level: 'silent' }),
    });
    bus.emit({ type: 'system.notice', propertyId: a.id, audience: {}, data: { message: 'hi' } });
    await local.idle();
    expect(notify).not.toHaveBeenCalled();
    local.stop();
  });
});
