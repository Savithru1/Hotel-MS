import type { ResponseTimeDto, ResponseTimesDto } from '@hospitality/shared-types';
import type { HistoryEntry } from '../../shared/state-machine';
import { FoodOrder } from '../food-orders/food-order.model';
import { MaintenanceIssue } from '../maintenance/maintenance.model';
import { ServiceRequest } from '../service-requests/service-request.model';
import { rangeInstants, type DateRange } from './stats.range';

/** One piece of work: when it was created, when somebody first acted on it, when it finished. */
interface Sample {
  createdAt: Date;
  firstAction: Date | null;
  done: Date | null;
}

type Dated = Pick<HistoryEntry, 'to' | 'at'>;

/** The time of the first history entry that moved the item to one of the given states. */
function firstReached(history: readonly Dated[], states: readonly string[]): Date | null {
  return history.find((entry) => states.includes(entry.to))?.at ?? null;
}

/** Whole seconds, averaged over the samples that have the figure. `null` when none do. */
function averageSeconds(
  samples: readonly Sample[],
  pick: (sample: Sample) => Date | null,
): number | null {
  const gaps = samples.flatMap((sample) => {
    const end = pick(sample);
    return end ? [Math.max(0, end.getTime() - sample.createdAt.getTime())] : [];
  });
  if (gaps.length === 0) return null;
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  return Math.round(mean / 1000);
}

function summarise(samples: readonly Sample[]): ResponseTimeDto {
  return {
    n: samples.length,
    firstActionSeconds: averageSeconds(samples, (sample) => sample.firstAction),
    completionSeconds: averageSeconds(samples, (sample) => sample.done),
  };
}

async function housekeeping(created: { $gte: Date; $lt: Date }): Promise<Sample[]> {
  const items = await ServiceRequest.find(
    { createdAt: created, status: { $ne: 'cancelled' } },
    { createdAt: 1, completedAt: 1, 'history.to': 1, 'history.at': 1 },
  ).lean();
  return items.map((item) => ({
    createdAt: item.createdAt,
    firstAction: firstReached(item.history, ['in_progress']),
    done: item.completedAt,
  }));
}

async function maintenance(created: { $gte: Date; $lt: Date }): Promise<Sample[]> {
  const items = await MaintenanceIssue.find(
    { createdAt: created },
    { createdAt: 1, resolvedAt: 1, 'history.to': 1, 'history.at': 1 },
  ).lean();
  return items.map((item) => ({
    createdAt: item.createdAt,
    firstAction:
      firstReached(item.history, ['assigned']) ?? firstReached(item.history, ['in_progress']),
    done: item.resolvedAt,
  }));
}

async function kitchen(created: { $gte: Date; $lt: Date }): Promise<Sample[]> {
  const items = await FoodOrder.find(
    { createdAt: created, status: { $ne: 'cancelled' } },
    { createdAt: 1, preparingAt: 1, deliveredAt: 1 },
  ).lean();
  return items.map((item) => ({
    createdAt: item.createdAt,
    firstAction: item.preparingAt,
    done: item.deliveredAt,
  }));
}

/**
 * How quickly work gets picked up and finished, for items created in the range (by property-local
 * day) and not cancelled. Spa bookings are scheduled for a time, so waiting time means nothing
 * for them and they are left out.
 */
export async function responseTimesFor(
  range: DateRange,
  timezone: string,
): Promise<ResponseTimesDto> {
  const { start, end } = rangeInstants(range, timezone);
  const created = { $gte: start, $lt: end };
  const [hk, mt, kt] = await Promise.all([
    housekeeping(created),
    maintenance(created),
    kitchen(created),
  ]);
  return {
    ...range,
    housekeeping: summarise(hk),
    maintenance: summarise(mt),
    kitchen: summarise(kt),
  };
}
