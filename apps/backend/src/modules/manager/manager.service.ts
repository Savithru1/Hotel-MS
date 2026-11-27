import type {
  OccupancyDto,
  OverviewDto,
  ResponseTimesDto,
  RevenueDto,
} from '@hospitality/shared-types';
import { addDays, localDateTimeToUtc, todayIn } from '../../shared/dates';
import { getTenantId } from '../../shared/request-context';
import type { PropertyService } from '../properties/property.service';
import { movements, occupancyDays, roomCounts } from './stats.occupancy';
import { openEscalations, queuesFor, type DayBounds } from './stats.queues';
import { resolveRange } from './stats.range';
import { responseTimesFor } from './stats.response-times';
import { revenueFor } from './stats.revenue';

export interface RangeInput {
  from?: string | undefined;
  to?: string | undefined;
}

/** Where the service gets "now" from. Tests pass a fixed one. */
export interface Clock {
  now(): Date;
}

export interface ManagerService {
  /** The live picture for one local date (today in the property's timezone when none is given). */
  overview(date?: string): Promise<OverviewDto>;
  occupancy(input: RangeInput): Promise<OccupancyDto>;
  revenue(input: RangeInput): Promise<RevenueDto>;
  responseTimes(input: RangeInput): Promise<ResponseTimesDto>;
}

interface PropertyDay {
  timezone: string;
  today: string;
}

const NO_OCCUPANCY = { occupied: 0, sellable: 0, rateBp: null };

function boundsOf(date: string, timezone: string): DayBounds {
  return {
    start: localDateTimeToUtc(date, '00:00', timezone),
    end: localDateTimeToUtc(addDays(date, 1), '00:00', timezone),
  };
}

export function createManagerService(
  properties: PropertyService,
  clock: Clock = { now: () => new Date() },
): ManagerService {
  /** The signed-in property's timezone and its current local date. */
  async function context(): Promise<PropertyDay> {
    const tenant = getTenantId();
    if (!tenant) throw new Error('No tenant context');
    const { timezone } = await properties.get(tenant);
    return { timezone, today: todayIn(timezone, clock.now()) };
  }

  return {
    async overview(date) {
      const { timezone, today } = await context();
      const day = date ?? today;
      const [rooms, moves, occupancy, queues, escalations] = await Promise.all([
        roomCounts(),
        movements(day),
        occupancyDays({ from: day, to: day }, today),
        queuesFor(boundsOf(day, timezone)),
        openEscalations(),
      ]);
      const { occupied, sellable, rateBp } = occupancy[0] ?? NO_OCCUPANCY;
      return {
        date: day,
        timezone,
        rooms,
        occupancy: { occupied, sellable, rateBp },
        arrivals: { expected: moves.arrivals.expected, checkedIn: moves.arrivals.done },
        departures: { expected: moves.departures.expected, checkedOut: moves.departures.done },
        inHouse: moves.inHouse,
        queues,
        escalations,
      };
    },

    async occupancy(input) {
      const { today } = await context();
      const range = resolveRange(input, today);
      return { ...range, days: await occupancyDays(range, today) };
    },

    async revenue(input) {
      const { timezone, today } = await context();
      return revenueFor(resolveRange(input, today), timezone);
    },

    async responseTimes(input) {
      const { timezone, today } = await context();
      return responseTimesFor(resolveRange(input, today), timezone);
    },
  };
}
