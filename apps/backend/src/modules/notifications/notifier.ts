import type { NotificationLinkKind, NotificationType } from '@hospitality/constants';
import { Types } from 'mongoose';
import type { Logger } from 'pino';
import type { AppEvents, DomainEvent, EventBus, EventType } from '../../shared/events/event-bus';
import { getContext, runWithContext, type Principal } from '../../shared/request-context';
import { managersOf } from './managers';
import type { NotificationService } from './notification.service';

const SYSTEM: Principal = { kind: 'system', id: 'system' };
const MINUTE_MS = 60_000;

export interface Notifier {
  /** Stops listening to the bus. */
  stop(): void;
  /** Resolves when every notification already being written has been written (or has failed). */
  idle(): Promise<void>;
}

export interface NotifierOptions {
  bus: EventBus;
  notifications: Pick<NotificationService, 'notify'>;
  logger: Pick<Logger, 'error'>;
}

/** Who should be told, and what to tell them. Built from the event alone. */
interface Plan {
  /** `managers` means every active manager and property admin of the property. */
  to: 'managers' | string;
  type: NotificationType;
  title: string;
  body: string;
  link: { kind: NotificationLinkKind; id: string };
  /** The same action seen twice in one minute is stored once; a later repeat is new. */
  dedupeKey: string;
}

function isEvent<K extends EventType>(event: DomainEvent, type: K): event is DomainEvent<K> {
  return event.type === type;
}

const bucket = (): number => Math.floor(Date.now() / MINUTE_MS);

function housekeepingPlan(data: AppEvents['housekeeping.changed']): Plan | null {
  const link = { kind: 'housekeeping', id: data.requestId } as const;
  if (data.change === 'escalated') {
    return {
      to: 'managers',
      type: 'escalation',
      title: `Room ${data.roomNumber}: housekeeping request escalated`,
      body: `A housekeeping request for room ${data.roomNumber} was escalated and needs attention.`,
      link,
      dedupeKey: `escalation:housekeeping:${data.requestId}:${bucket()}`,
    };
  }
  if ((data.change === 'assigned' || data.change === 'reassigned') && data.assignedTo) {
    return {
      to: data.assignedTo,
      type: 'new_assignment',
      title: `Room ${data.roomNumber}: housekeeping task assigned to you`,
      body: `You were given a housekeeping task for room ${data.roomNumber}.`,
      link,
      dedupeKey: `assigned:housekeeping:${data.requestId}:${data.assignedTo}:${bucket()}`,
    };
  }
  return null;
}

function maintenancePlan(data: AppEvents['maintenance.changed']): Plan | null {
  const link = { kind: 'maintenance', id: data.issueId } as const;
  if (data.change === 'escalated') {
    return {
      to: 'managers',
      type: 'escalation',
      title: `Room ${data.roomNumber}: maintenance issue escalated`,
      body: `A ${data.priority}-priority maintenance issue for room ${data.roomNumber} was escalated.`,
      link,
      dedupeKey: `escalation:maintenance:${data.issueId}:${bucket()}`,
    };
  }
  if (data.change === 'created' && (data.priority === 'urgent' || data.priority === 'high')) {
    return {
      to: 'managers',
      type: 'urgent_issue',
      title: `Room ${data.roomNumber}: ${data.priority} maintenance issue`,
      body: `A ${data.priority}-priority maintenance issue was reported for room ${data.roomNumber}.`,
      link,
      dedupeKey: `urgent:maintenance:${data.issueId}`,
    };
  }
  if ((data.change === 'assigned' || data.change === 'reassigned') && data.assignedTo) {
    return {
      to: data.assignedTo,
      type: 'new_assignment',
      title: `Room ${data.roomNumber}: maintenance issue assigned to you`,
      body: `You were given a ${data.priority}-priority maintenance issue for room ${data.roomNumber}.`,
      link,
      dedupeKey: `assigned:maintenance:${data.issueId}:${data.assignedTo}:${bucket()}`,
    };
  }
  return null;
}

function planFor(event: DomainEvent): Plan | null {
  if (isEvent(event, 'housekeeping.changed')) return housekeepingPlan(event.data);
  if (isEvent(event, 'maintenance.changed')) return maintenancePlan(event.data);
  return null;
}

/**
 * Turns in-process bus events into stored notifications. The bus handler is synchronous, so the
 * work is started and tracked here and never awaited by whoever raised the event; a failure is
 * logged, never thrown back. (A crash can lose a notification; the SLA scan is the safety net.)
 *
 * The person who caused the event is never notified about their own action.
 */
export function startNotifier({ bus, notifications, logger }: NotifierOptions): Notifier {
  const inFlight = new Set<Promise<void>>();

  async function deliver(
    event: DomainEvent,
    plan: Plan,
    actorId: string | undefined,
  ): Promise<void> {
    const propertyId = new Types.ObjectId(String(event.propertyId));
    const people = plan.to === 'managers' ? await managersOf(propertyId) : [plan.to];
    const recipientIds = people.filter((id) => id !== actorId);
    if (recipientIds.length === 0) return;
    await notifications.notify({
      recipientIds,
      type: plan.type,
      title: plan.title,
      body: plan.body,
      link: plan.link,
      dedupeKey: plan.dedupeKey,
    });
  }

  const unsubscribe = bus.subscribe((event) => {
    const plan = planFor(event);
    if (!plan) return;
    // Read synchronously: this runs inside the request that raised the event.
    const actorId = getContext()?.principal?.id;
    const propertyId = new Types.ObjectId(String(event.propertyId));

    const work = runWithContext({ propertyId, principal: SYSTEM }, () =>
      deliver(event, plan, actorId),
    )
      .catch((error: unknown) => {
        logger.error({ err: error, event: event.type }, 'Could not store a notification');
      })
      .finally(() => {
        inFlight.delete(work);
      });
    inFlight.add(work);
  });

  return {
    stop: unsubscribe,
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
