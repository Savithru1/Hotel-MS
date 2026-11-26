/**
 * Hotel dates are calendar dates in the property's own timezone, written `YYYY-MM-DD`. A "night"
 * is named by the date it starts on. Using plain date strings (never JavaScript Date objects
 * that carry a clock time) means a booking for 12 to 14 March is the same two nights whatever
 * the server's timezone is, and whichever side of midnight "now" falls on.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function toUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  return new Date(toUtcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

/** Today's date in the given IANA timezone. `now` is injectable so tests control the clock. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  // The `en-CA` locale formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The nights of a stay: every date from check-in up to but not including check-out. A guest
 * leaving on the morning a new guest arrives does not conflict, because the night of the check-out
 * date is not part of the first stay.
 */
export function nightsOf(checkInDate: string, checkOutDate: string): string[] {
  const count = daysBetween(checkInDate, checkOutDate);
  return Array.from({ length: Math.max(0, count) }, (_, index) => addDays(checkInDate, index));
}
