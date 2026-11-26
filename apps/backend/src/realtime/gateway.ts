import type { Server as HttpServer } from 'node:http';
import { isManagementRole } from '@hospitality/constants';
import { createAdapter } from '@socket.io/mongo-adapter';
import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { Server, type Socket } from 'socket.io';
import type { Env } from '../config/environment';
import type { AuthService } from '../modules/auth/auth.service';
import type { AuthenticatedStaff } from '../modules/auth/auth.types';
import type { TokenService } from '../modules/auth/token.service';
import type { EventBus } from '../shared/events/event-bus';
import { rooms, roomsFor } from '../shared/events/rooms';

export interface GatewayOptions {
  httpServer: HttpServer;
  env: Env;
  tokens: TokenService;
  auth: AuthService;
  bus: EventBus;
  logger: Logger;
}

interface Connection {
  staff: AuthenticatedStaff;
  expiresAt: Date;
}

interface SocketData {
  connection: Connection;
}

/** Clients send nothing meaningful, so there are no client-to-server events. */
type ClientToServer = Record<string, never>;
interface ServerToClient {
  ready: (info: { at: string }) => void;
  event: (message: RealtimeMessage) => void;
}
type GatewayServer = Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;
type GatewaySocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

export interface Gateway {
  io: GatewayServer;
  close(): Promise<void>;
}

const ADAPTER_COLLECTION = 'socket_io_events';
const ADAPTER_SIZE_BYTES = 8 * 1024 * 1024;
// Clients only ever listen, so there is no reason to accept anything large from them.
const MAX_CLIENT_MESSAGE_BYTES = 4 * 1024;

/** The wire format. Ids and minimal data only; the client refetches over REST. */
export interface RealtimeMessage {
  type: string;
  data: unknown;
  at: string;
}

async function connectionFor(
  socket: GatewaySocket,
  tokens: TokenService,
  auth: AuthService,
): Promise<Connection | null> {
  const token = socket.handshake.auth?.token;
  if (typeof token !== 'string' || token.length === 0 || token.length > 2000) return null;
  try {
    const claims = await tokens.verifyAccessToken(token);
    const staff = await auth.loadActiveStaff(claims.staffId, claims.propertyId, claims.issuedAt);
    return staff ? { staff, expiresAt: claims.expiresAt } : null;
  } catch {
    return null;
  }
}

/**
 * The one place that touches sockets. It does three things and nothing else:
 *
 * 1. Authenticates the handshake with the access token and re-reads the account from the
 *    database (role, departments, active) so the token cannot grant more than the database does.
 * 2. Decides, on the server, which rooms the connection joins. Clients cannot join rooms by
 *    name (socket.io has no client-side join) and every message a client sends is ignored.
 * 3. Forwards events from the in-process bus to the right rooms.
 *
 * A connection is closed when its access token expires; the client refreshes the token and
 * reconnects, which also re-checks that the account is still active.
 */
export async function attachGateway({
  httpServer,
  env,
  tokens,
  auth,
  bus,
  logger,
}: GatewayOptions): Promise<Gateway> {
  const io: GatewayServer = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    maxHttpBufferSize: MAX_CLIENT_MESSAGE_BYTES,
    serveClient: false,
  });

  if (env.SOCKET_ADAPTER === 'mongo') {
    // Only needed when a second backend instance exists. The adapter keeps its own capped
    // collection of socket events; it holds no hotel data and is not tenant scoped.
    const db = mongoose.connection.db;
    if (!db) throw new Error('The database must be connected before the realtime gateway starts');
    await db
      .createCollection(ADAPTER_COLLECTION, { capped: true, size: ADAPTER_SIZE_BYTES })
      .catch((error: { codeName?: string }) => {
        if (error.codeName !== 'NamespaceExists') throw error;
      });
    // eslint-disable-next-line no-restricted-properties -- the adapter's own capped collection
    io.adapter(createAdapter(db.collection(ADAPTER_COLLECTION)));
  }

  io.use((socket, next) => {
    connectionFor(socket, tokens, auth).then(
      (connection) => {
        if (!connection) {
          next(new Error('unauthorized'));
          return;
        }
        socket.data.connection = connection;
        next();
      },
      () => next(new Error('unauthorized')),
    );
  });

  io.on('connection', (socket) => {
    const { staff, expiresAt } = socket.data.connection;
    const propertyId = staff.propertyId.toHexString();

    // Managers and admins hear everything in their property through the managers room, so they
    // are not also put in each department room. Everyone else gets only their own departments.
    if (isManagementRole(staff.role)) {
      void socket.join(rooms.managers(propertyId));
    } else {
      for (const department of staff.departments) {
        void socket.join(rooms.department(propertyId, department));
      }
    }
    void socket.join(rooms.staff(propertyId, staff.id.toHexString()));

    socket.emit('ready', { at: new Date().toISOString() });

    // End the connection when the access token runs out.
    const timer = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, expiresAt.getTime() - Date.now()),
    );
    timer.unref();
    socket.on('disconnect', () => clearTimeout(timer));

    // Nothing a client sends does anything. Mutations go through REST, where RBAC is enforced.
    socket.onAny(() => undefined);
  });

  const unsubscribe = bus.subscribe((event) => {
    const targets = roomsFor(event);
    if (targets.length === 0) return;
    const message: RealtimeMessage = {
      type: event.type,
      data: event.data,
      at: new Date().toISOString(),
    };
    io.to(targets).emit('event', message);
  });

  logger.info({ adapter: env.SOCKET_ADAPTER }, 'Realtime gateway ready');

  return {
    io,
    async close() {
      unsubscribe();
      await io.close();
    },
  };
}
