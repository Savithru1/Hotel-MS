import type {
  AuditEntryDto,
  NotificationDto,
  OccupancyDto,
  OverviewDto,
  ResponseTimesDto,
  RevenueAmountDto,
  RevenueDto,
} from '@hospitality/shared-types';

/** Hand-picked, all-different numbers so a test can tell one tile from another. */
export function overviewFixture(overrides: Partial<OverviewDto> = {}): OverviewDto {
  return {
    date: '2026-11-27',
    timezone: 'Asia/Kolkata',
    rooms: {
      active: 24,
      byStatus: { available: 11, occupied: 8, cleaning: 3, maintenance: 1, out_of_service: 1 },
    },
    occupancy: { occupied: 8, sellable: 24, rateBp: 3333 },
    arrivals: { expected: 6, checkedIn: 4 },
    departures: { expected: 5, checkedOut: 2 },
    inHouse: 7,
    queues: {
      housekeeping: { pending: 5, completedToday: 12, escalated: 1, urgent: 2 },
      maintenance: { pending: 3, completedToday: 4, escalated: 1, urgent: 0 },
      kitchen: { pending: 6, completedToday: 21, escalated: 0, urgent: 0 },
      spa: { pending: 2, completedToday: 7, escalated: 0, urgent: 0 },
    },
    escalations: [
      {
        kind: 'housekeeping',
        id: 'h1',
        roomNumber: '204',
        reason: 'Guest waiting at the door',
        escalatedAt: '2026-11-27T05:30:00.000Z',
        priority: 'urgent',
      },
      {
        kind: 'maintenance',
        id: 'm1',
        roomNumber: '310',
        reason: 'Water leak in the bathroom',
        escalatedAt: '2026-11-27T04:10:00.000Z',
        priority: 'high',
      },
    ],
    ...overrides,
  };
}

export const amount = (taxablePaise: number, taxPaise: number): RevenueAmountDto => ({
  taxablePaise,
  taxPaise,
  totalPaise: taxablePaise + taxPaise,
});

const none = amount(0, 0);

export function occupancyFixture(): OccupancyDto {
  return {
    from: '2026-11-26',
    to: '2026-11-28',
    days: [
      { date: '2026-11-26', occupied: 9, sellable: 24, rateBp: 3750, basis: 'actual' },
      { date: '2026-11-27', occupied: 8, sellable: 24, rateBp: 3333, basis: 'actual' },
      { date: '2026-11-28', occupied: 12, sellable: 24, rateBp: 5000, basis: 'on_the_books' },
    ],
  };
}

/** Room 200000 paise taxable at 12% GST, food 50000 at 5%; one day with nothing, one with a refund. */
export function revenueFixture(overrides: Partial<RevenueDto> = {}): RevenueDto {
  const room = amount(200_000, 24_000);
  const food = amount(50_000, 2_500);
  const total = amount(250_000, 26_500);
  return {
    from: '2026-11-26',
    to: '2026-11-27',
    days: [
      {
        date: '2026-11-26',
        departments: { room, food, spa_recreation: none, other: none },
        total,
      },
      {
        date: '2026-11-27',
        departments: {
          room: none,
          food: none,
          spa_recreation: amount(80_000, 14_400),
          other: amount(10_000, 1_800),
        },
        total: amount(90_000, 16_200),
      },
    ],
    totals: {
      departments: {
        room,
        food,
        spa_recreation: amount(80_000, 14_400),
        other: amount(10_000, 1_800),
      },
      total: amount(340_000, 42_700),
    },
    payments: [
      { date: '2026-11-26', receivedPaise: 300_000, refundedPaise: 12_345 },
      { date: '2026-11-27', receivedPaise: 150_000, refundedPaise: 0 },
    ],
    lastSyncedAt: '2026-11-27T06:15:00.000Z',
    ...overrides,
  };
}

export function responseTimesFixture(overrides: Partial<ResponseTimesDto> = {}): ResponseTimesDto {
  return {
    from: '2026-11-26',
    to: '2026-11-27',
    housekeeping: { n: 7, firstActionSeconds: 600, completionSeconds: 1_805 },
    maintenance: { n: 3, firstActionSeconds: 45, completionSeconds: 7_500 },
    kitchen: { n: 0, firstActionSeconds: null, completionSeconds: null },
    ...overrides,
  };
}

export function auditEntry(overrides: Partial<AuditEntryDto> = {}): AuditEntryDto {
  return {
    id: 'a1',
    at: '2026-11-27T05:00:00.000Z',
    actor: { kind: 'staff', id: 's1', role: 'manager', name: 'Meera Nair' },
    action: 'staff.update',
    target: { type: 'staff', id: 'st9' },
    summary: { role: 'kitchen', password: '[redacted]' },
    ...overrides,
  };
}

export function notification(overrides: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: 'n1',
    type: 'escalation',
    title: 'Room 204 escalated',
    body: 'Guest waiting at the door',
    link: { kind: 'housekeeping', id: 'h1' },
    readAt: null,
    createdAt: '2026-11-27T05:30:00.000Z',
    ...overrides,
  };
}
