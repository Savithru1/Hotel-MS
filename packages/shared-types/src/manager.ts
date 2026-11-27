import type { GstCategory, NotificationLinkKind, NotificationType } from '@hospitality/constants';

// Notifications --------------------------------------------------------------------------

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  /** What the notification is about. Ids only: the screen fetches the details itself. */
  link: { kind: NotificationLinkKind; id: string };
  readAt: string | null;
  createdAt: string;
}

export interface UnreadCountDto {
  unread: number;
}

// Manager dashboard (served in slice 2) --------------------------------------------------

export interface QueueOverviewDto {
  /** Open and not yet finished. */
  pending: number;
  /** Finished during the property's current local day. */
  completedToday: number;
  escalated: number;
  urgent: number;
}

export interface OverviewEscalationDto {
  kind: 'housekeeping' | 'maintenance';
  id: string;
  roomNumber: string | null;
  reason: string | null;
  escalatedAt: string | null;
  priority: string;
}

export interface OverviewDto {
  /** The property-local date the figures are for, `YYYY-MM-DD`. */
  date: string;
  timezone: string;
  rooms: { active: number; byStatus: Record<string, number> };
  /** `rateBp` is in basis points (10000 = 100%) and `null` when there are no sellable rooms. */
  occupancy: { occupied: number; sellable: number; rateBp: number | null };
  arrivals: { expected: number; checkedIn: number };
  departures: { expected: number; checkedOut: number };
  inHouse: number;
  queues: {
    housekeeping: QueueOverviewDto;
    maintenance: QueueOverviewDto;
    kitchen: QueueOverviewDto;
    spa: QueueOverviewDto;
  };
  escalations: OverviewEscalationDto[];
}

export interface OccupancyDayDto {
  date: string;
  occupied: number;
  /** Today's count of active rooms: room status history is not kept. */
  sellable: number;
  rateBp: number | null;
  /** Past days and today count checked-in/out stays; later days are bookings on the books. */
  basis: 'actual' | 'on_the_books';
}

export interface RevenueAmountDto {
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
}

export interface RevenueDayDto {
  date: string;
  departments: Record<GstCategory, RevenueAmountDto>;
  total: RevenueAmountDto;
}

export interface CashFlowDayDto {
  date: string;
  receivedPaise: number;
  refundedPaise: number;
}

export interface RevenueDto {
  from: string;
  to: string;
  days: RevenueDayDto[];
  totals: { departments: Record<GstCategory, RevenueAmountDto>; total: RevenueAmountDto };
  payments: CashFlowDayDto[];
  /** When bills were last brought up to date by the sync job, or null if it has not run. */
  lastSyncedAt: string | null;
}

export interface ResponseTimeDto {
  /** How many items the averages are based on. */
  n: number;
  /** Average seconds to first action, or `null` when there is no data (never 0). */
  firstActionSeconds: number | null;
  /** Average seconds to completion, or `null` when there is no data (never 0). */
  completionSeconds: number | null;
}

export interface ResponseTimesDto {
  from: string;
  to: string;
  housekeeping: ResponseTimeDto;
  maintenance: ResponseTimeDto;
  kitchen: ResponseTimeDto;
}

// Audit log ------------------------------------------------------------------------------

export interface AuditEntryDto {
  id: string;
  at: string;
  actor: {
    kind: 'staff' | 'guest' | 'system';
    id: string;
    role: string | null;
    name: string | null;
  };
  action: string;
  target: { type: string; id: string };
  summary: Record<string, unknown> | null;
}
