import { MAX_STATS_RANGE_DAYS } from '@hospitality/constants';
import { addDays, daysBetween, localDateTimeToUtc } from '../../shared/dates';
import { badRequest } from '../../shared/errors';

/** Both ends inclusive, `YYYY-MM-DD` in the property's timezone. */
export interface DateRange {
  from: string;
  to: string;
}

interface RangeInput {
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Fills in the dates a caller left out and checks the result. Nothing at all means today. The
 * route's schema has already refused a backwards or too long range when both dates were given;
 * this checks again because a default can create one (`from` a year ago with no `to`).
 */
export function resolveRange(input: RangeInput, today: string): DateRange {
  const to = input.to ?? (input.from && input.from > today ? input.from : today);
  const from = input.from ?? to;
  const days = daysBetween(from, to) + 1;
  if (days < 1) throw badRequest('"from" must not be after "to"', 'invalid_range');
  if (days > MAX_STATS_RANGE_DAYS) {
    throw badRequest(`The range can cover at most ${MAX_STATS_RANGE_DAYS} days`, 'range_too_long');
  }
  return { from, to };
}

/** Every date from `from` to `to`, inclusive. */
export function eachDate({ from, to }: DateRange): string[] {
  return Array.from({ length: daysBetween(from, to) + 1 }, (_, index) => addDays(from, index));
}

/** The instants a range of local dates covers: from midnight of `from` up to midnight after `to`. */
export function rangeInstants(
  { from, to }: DateRange,
  timezone: string,
): { start: Date; end: Date } {
  return {
    start: localDateTimeToUtc(from, '00:00', timezone),
    end: localDateTimeToUtc(addDays(to, 1), '00:00', timezone),
  };
}

/** Rounds a ratio of whole numbers to the nearest integer, or null when there is nothing to divide by. */
export function basisPoints(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part * 10_000) / whole);
}
