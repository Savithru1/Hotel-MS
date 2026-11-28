import type { Query } from '../../api/client';
import { truncate } from './format';

export const AUDIT_PAGE_SIZE = 25;

/** What the filter form holds. Empty strings mean "no filter". */
export interface AuditFilters {
  from: string;
  to: string;
  action: string;
  actor: string;
  targetType: string;
  targetId: string;
}

export const EMPTY_FILTERS: AuditFilters = {
  from: '',
  to: '',
  action: '',
  actor: '',
  targetType: '',
  targetId: '',
};

/** The query string for `GET /audit-logs`: filled filters only, trimmed, under the server's names. */
export function buildAuditQuery(filters: AuditFilters, page: number): Query {
  const given: [string, string][] = [
    ['from', filters.from],
    ['to', filters.to],
    ['action', filters.action],
    ['actorId', filters.actor],
    ['targetType', filters.targetType],
    ['targetId', filters.targetId],
  ];
  const filled = given
    .map(([key, value]): [string, string] => [key, value.trim()])
    .filter(([, value]) => value !== '');
  return { page, limit: AUDIT_PAGE_SIZE, ...Object.fromEntries(filled) };
}

const valueText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));

/**
 * One line of "key: value" for the details column, cut at `max` characters. The values are
 * already redacted by the server; this only keeps a huge summary from filling the screen.
 */
export function summaryText(summary: Record<string, unknown> | null, max: number): string {
  if (!summary) return '';
  const text = Object.entries(summary)
    .map(([key, value]) => `${key}: ${valueText(value)}`)
    .join(', ');
  return truncate(text, max);
}
