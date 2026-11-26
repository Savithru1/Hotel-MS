import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { useApi } from '../api/ApiContext';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** What the server sends: ids and a few fields. The page refetches over REST for the details. */
export interface RealtimeMessage {
  type: string;
  data: Record<string, unknown>;
  at: string;
}

type Listener = (message: RealtimeMessage) => void;

interface RealtimeValue {
  status: ConnectionStatus;
  subscribe(listener: Listener): () => void;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

/** The slice of a socket this provider uses, so tests can pass a fake. */
export type SocketLike = Pick<Socket, 'on' | 'off' | 'connect' | 'disconnect' | 'io'>;
export type SocketFactory = (options: {
  auth: (callback: (data: { token: string | null }) => void) => void;
}) => SocketLike;

const defaultFactory: SocketFactory = (options) =>
  io({
    path: '/socket.io',
    transports: ['websocket'],
    auth: options.auth,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });

/**
 * Keeps one live connection while someone is signed in. It always sends the newest access
 * token when it (re)connects. The server closes a connection when its token expires; this
 * renews the token through a normal API call and connects again, which also confirms the account
 * is still active. Messages are only hints to refetch: every real read goes through REST.
 */
export function RealtimeProvider({
  children,
  createSocket = defaultFactory,
}: {
  children: ReactNode;
  createSocket?: SocketFactory;
}) {
  const api = useApi();
  const queries = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    let closed = false;
    const socket = createSocket({
      auth: (callback) => callback({ token: api.accessToken() }),
    });

    const renewAndReconnect = (): void => {
      // Any call renews an expired token as a side effect. Wait a moment so a refused
      // session does not turn into a tight loop.
      setTimeout(() => {
        if (closed) return;
        api
          .get('/auth/me')
          .then(() => {
            if (!closed) socket.connect();
          })
          .catch(() => {
            if (!closed) setStatus('offline');
          });
      }, 500);
    };

    let connectedBefore = false;
    const onConnect = (): void => {
      setStatus('connected');
      // Events sent while the connection was down are gone, so after a reconnect every screen
      // is refreshed from the server instead of trusting what it last showed.
      if (connectedBefore) void queries.invalidateQueries();
      connectedBefore = true;
    };
    const onDisconnect = (reason: string): void => {
      setStatus('reconnecting');
      // The server ended the connection (token expired): the client will not retry by itself.
      if (reason === 'io server disconnect') renewAndReconnect();
    };
    const onConnectError = (error: Error): void => {
      setStatus('reconnecting');
      if (error.message === 'unauthorized') renewAndReconnect();
    };
    const onEvent = (message: RealtimeMessage): void => {
      for (const listener of listeners.current) listener(message);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('event', onEvent);

    return () => {
      closed = true;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('event', onEvent);
      socket.disconnect();
    };
  }, [api, createSocket, queries]);

  const value = useMemo<RealtimeValue>(
    () => ({
      status,
      subscribe(listener) {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
    }),
    [status],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useConnectionStatus(): ConnectionStatus {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useConnectionStatus must be used inside <RealtimeProvider>');
  return value.status;
}

/** Calls `handler` for every live message whose type is in `types` (all messages if omitted). */
export function useRealtime(handler: Listener, types?: readonly string[]): void {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  const latest = useRef(handler);
  latest.current = handler;
  const wanted = types?.join('|');

  useEffect(() => {
    const accepted = wanted ? new Set(wanted.split('|')) : null;
    return value.subscribe((message) => {
      if (!accepted || accepted.has(message.type)) latest.current(message);
    });
  }, [value, wanted]);
}

/** Refetch the given queries whenever one of the given live events arrives. */
export function useRefetchOnEvents(types: readonly string[], keys: readonly QueryKey[]): void {
  const queries = useQueryClient();
  useRealtime(() => {
    for (const queryKey of keys) void queries.invalidateQueries({ queryKey });
  }, types);
}
