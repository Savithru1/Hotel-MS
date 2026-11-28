export { dateTimeLabel } from '../../components/ui';

/** What a figure shows when the server has nothing to base it on. Never a made-up zero. */
export const NO_DATA = 'No data';

/** `rateBp` is basis points (10000 = 100%). `null` means there is nothing to divide by. */
export function rateLabel(rateBp: number | null): string {
  if (rateBp === null) return NO_DATA;
  const percent = (rateBp / 100).toLocaleString('en-IN', { maximumFractionDigits: 1 });
  return `${percent}%`;
}

const MINUTE = 60;
const HOUR = 3_600;

/** Whole seconds as "45 s", "10 min", "30 min 5 s" or "2 h 5 min". `null` means no data. */
export function durationLabel(seconds: number | null): string {
  if (seconds === null) return NO_DATA;
  const total = Math.round(seconds);
  const hours = Math.floor(total / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  const rest = total % MINUTE;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} h`);
  if (minutes > 0) parts.push(`${minutes} min`);
  // Seconds only matter for short waits; "2 h 5 min 7 s" is noise.
  if (hours === 0 && (rest > 0 || parts.length === 0)) parts.push(`${rest} s`);
  return parts.join(' ');
}

/** Today's date as `YYYY-MM-DD` on this device, the same way the other screens pick a day. */
export const todayLocal = (): string => new Date().toLocaleDateString('en-CA');

/** Cuts long text so a table cell never fills the screen. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
