import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../test/db';
import { testEnv } from '../../test/env';
import { createApp } from '../app';
import { seedDevelopmentData, type SeededProperty } from '../modules/seed/seed';
import { buildServices } from '../services';
import { createEventBus } from '../shared/events/event-bus';
import { attachGateway, type Gateway, type RealtimeMessage } from './gateway';

useTestDatabase();

const env = testEnv({ SOCKET_ADAPTER: 'mongo' });
const services = buildServices(env);

interface Instance {
  server: HttpServer;
  gateway: Gateway;
  bus: ReturnType<typeof createEventBus>;
  url: string;
}

async function startInstance(): Promise<Instance> {
  const bus = createEventBus();
  const server = createServer(createApp({ env, logger: pino({ level: 'silent' }), services }));
  const gateway = await attachGateway({
    httpServer: server,
    env,
    tokens: services.tokens,
    auth: services.auth,
    bus,
    logger: pino({ level: 'silent' }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    gateway,
    bus,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

let one: Instance;
let two: Instance;
let property: SeededProperty;

beforeAll(async () => {
  [property] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  one = await startInstance();
  two = await startInstance();
});

afterAll(async () => {
  await one.gateway.close();
  await two.gateway.close();
});

describe('Mongo socket adapter (for running more than one backend instance)', () => {
  it('delivers an event emitted on one instance to a client connected to another', async () => {
    const staff = property.staff.kitchen;
    const token = await services.tokens.signAccessToken({
      staffId: staff?.id ?? property.id,
      propertyId: property.id,
    });
    const socket = connect(two.url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    const received: RealtimeMessage[] = [];
    socket.on('event', (message: RealtimeMessage) => received.push(message));
    await new Promise<void>((resolve, reject) => {
      socket.once('ready', () => resolve());
      socket.once('connect_error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    one.bus.emit({
      type: 'system.notice',
      propertyId: property.id,
      audience: { departments: ['kitchen'] },
      data: { message: 'across instances' },
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    socket.disconnect();

    expect(received).toHaveLength(1);
    expect(received[0]?.data).toEqual({ message: 'across instances' });
  });
});
