import { MAX_STATS_RANGE_DAYS } from '@hospitality/constants';
import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common';
import { dateOnlySchema } from './property';

const DAY_MS = 86_400_000;

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

// Notifications --------------------------------------------------------------------------

export const listNotificationsQuerySchema = paginationSchema.extend({
  /** `true` = only unread, `false` = only read, absent = both. */
  unread: booleanQuery,
});

export const markReadParamsSchema = z.object({ id: objectIdSchema });

// Date ranges ----------------------------------------------------------------------------

/** Both ends are inclusive `YYYY-MM-DD` dates in the property's timezone. */
const rangeShape = {
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
};

interface RangeLike {
  from?: string | undefined;
  to?: string | undefined;
}

/** Refuses a range that runs backwards or covers more than `MAX_STATS_RANGE_DAYS` days. */
function checkRange(range: RangeLike, context: z.RefinementCtx): void {
  if (!range.from || !range.to) return;
  const days =
    (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / DAY_MS;
  if (days < 0) {
    context.addIssue({ code: 'custom', path: ['from'], message: 'must not be after "to"' });
    return;
  }
  if (days + 1 > MAX_STATS_RANGE_DAYS) {
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: `the range can cover at most ${MAX_STATS_RANGE_DAYS} days`,
    });
  }
}

/** `?from=&to=`. Missing dates are filled in by the service, which knows the property's today. */
export const statsRangeQuerySchema = z.object(rangeShape).superRefine(checkRange);

const filterText = (max: number): z.ZodString => z.string().trim().min(1).max(max);

/** `GET /audit-logs`: a date range, optional filters, and the usual paging (limit at most 100). */
export const auditLogQuerySchema = paginationSchema
  .extend({
    ...rangeShape,
    action: filterText(100).optional(),
    /** A staff id, or `system` for work done by background jobs. */
    actorId: filterText(64).optional(),
    targetType: filterText(64).optional(),
    targetId: filterText(64).optional(),
  })
  .superRefine(checkRange);

export type StatsRangeQuery = z.output<typeof statsRangeQuerySchema>;
export type AuditLogQuery = z.output<typeof auditLogQuerySchema>;

/** `GET /manager/overview?date=`. A missing date means today in the property's timezone. */
export const overviewQuerySchema = z.object({ date: dateOnlySchema.optional() });

export type OverviewQuery = z.output<typeof overviewQuerySchema>;
