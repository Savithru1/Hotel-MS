import type { Department } from '@hospitality/constants';
import type { Types } from 'mongoose';

/**
 * The events services can emit. Each one carries only ids and the few fields a screen needs to
 * decide what to refetch: the client then asks the REST API for the details, so authorisation
 * stays in one place. Add an entry here when a module starts emitting a new event.
 */
export interface AppEvents {
  /** A booking was created, changed or moved to a new status. The front desk refetches it. */
  'booking.changed': {
    bookingId: string;
    bookingCode: string;
    status: string;
    roomId: string;
    change: string;
  };
  /** A room moved to a new status. Front desk, housekeeping and managers refetch the room board. */
  'room.status_changed': { roomId: string; roomNumber: string; status: string; previous: string };
  /** A plain notice for connected staff. Used by tests and operational messages. */
  'system.notice': { message: string };
}

export type EventType = keyof AppEvents;

/** Who should hear an event. Always inside one property; the gateway decides the actual rooms. */
export interface Audience {
  /** Staff working in these departments. */
  departments?: readonly Department[];
  /** Managers and admins of the property. Defaults to true. */
  managers?: boolean;
  /** Specific staff members. */
  staffIds?: readonly string[];
  /** Guest sessions for these bookings (used once the guest app exists, P1.12). */
  bookingIds?: readonly string[];
}

export interface DomainEvent<K extends EventType = EventType> {
  type: K;
  propertyId: Types.ObjectId | string;
  audience: Audience;
  data: AppEvents[K];
}

export type EventHandler = (event: DomainEvent) => void;

export interface EventBus {
  /**
   * Announces something that has happened. Call it after the database change has committed.
   * A failing listener never affects the caller.
   */
  emit<K extends EventType>(event: DomainEvent<K>): void;
  /** Returns a function that removes the listener. */
  subscribe(handler: EventHandler): () => void;
}

export interface EventBusOptions {
  onListenerError?: (error: unknown) => void;
}

/**
 * A typed in-process bus. Services emit onto it; only the socket gateway listens. Services never
 * touch sockets, so real-time delivery can change without touching business code.
 */
export function createEventBus({ onListenerError }: EventBusOptions = {}): EventBus {
  const handlers = new Set<EventHandler>();
  return {
    emit(event) {
      for (const handler of [...handlers]) {
        try {
          handler(event as DomainEvent);
        } catch (error) {
          onListenerError?.(error);
        }
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

/** The bus the running application uses. Tests create their own with `createEventBus`. */
export const eventBus: EventBus = createEventBus();
