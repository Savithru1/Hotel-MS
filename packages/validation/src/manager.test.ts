import { MAX_STATS_RANGE_DAYS } from '@hospitality/constants';
import { describe, expect, it } from 'vitest';
import {
  auditLogQuerySchema,
  listNotificationsQuerySchema,
  markReadParamsSchema,
  statsRangeQuerySchema,
} from './manager';

const ID = '0123456789abcdef01234567';

describe('listNotificationsQuerySchema', () => {
  it('defaults to the first page of 25 with no unread filter', () => {
    expect(listNotificationsQuerySchema.parse({})).toEqual({ page: 1, limit: 25 });
  });

  it('reads unread=true and unread=false as booleans', () => {
    expect(listNotificationsQuerySchema.parse({ unread: 'true' }).unread).toBe(true);
    expect(listNotificationsQuerySchema.parse({ unread: 'false' }).unread).toBe(false);
  });

  it('caps the page size at 100 and refuses other unread values', () => {
    expect(listNotificationsQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(listNotificationsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ unread: 'yes' }).success).toBe(false);
  });
});

describe('markReadParamsSchema', () => {
  it('accepts an object id and refuses anything else', () => {
    expect(markReadParamsSchema.parse({ id: ID })).toEqual({ id: ID });
    expect(markReadParamsSchema.safeParse({ id: 'nope' }).success).toBe(false);
    expect(markReadParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe('statsRangeQuerySchema', () => {
  it('accepts no dates at all (the service uses today)', () => {
    expect(statsRangeQuerySchema.parse({})).toEqual({});
  });

  it('accepts a single day and a range', () => {
    expect(statsRangeQuerySchema.parse({ from: '2026-03-01', to: '2026-03-01' })).toEqual({
      from: '2026-03-01',
      to: '2026-03-01',
    });
    expect(statsRangeQuerySchema.parse({ from: '2026-03-01', to: '2026-03-10' }).to).toBe(
      '2026-03-10',
    );
  });

  it('refuses from after to', () => {
    const result = statsRangeQuerySchema.safeParse({ from: '2026-03-10', to: '2026-03-09' });
    expect(result.success).toBe(false);
  });

  it('allows exactly 92 days inclusive and refuses 93', () => {
    expect(MAX_STATS_RANGE_DAYS).toBe(92);
    // 2026-01-01 .. 2026-04-02 is 92 days counting both ends.
    expect(statsRangeQuerySchema.safeParse({ from: '2026-01-01', to: '2026-04-02' }).success).toBe(
      true,
    );
    expect(statsRangeQuerySchema.safeParse({ from: '2026-01-01', to: '2026-04-03' }).success).toBe(
      false,
    );
  });

  it('refuses malformed and impossible dates', () => {
    expect(statsRangeQuerySchema.safeParse({ from: '01-03-2026' }).success).toBe(false);
    expect(statsRangeQuerySchema.safeParse({ to: '2026-02-31' }).success).toBe(false);
  });

  it('accepts a leap day and counts it in the range length', () => {
    expect(statsRangeQuerySchema.safeParse({ from: '2028-02-28', to: '2028-03-01' }).success).toBe(
      true,
    );
  });
});

describe('auditLogQuerySchema', () => {
  it('defaults paging and has every filter optional', () => {
    expect(auditLogQuerySchema.parse({})).toEqual({ page: 1, limit: 25 });
  });

  it('accepts every filter', () => {
    const parsed = auditLogQuerySchema.parse({
      from: '2026-03-01',
      to: '2026-03-05',
      action: 'housekeeping.escalated',
      actorId: ID,
      targetType: 'service_request',
      targetId: ID,
      page: '2',
      limit: '100',
    });
    expect(parsed).toMatchObject({ action: 'housekeeping.escalated', page: 2, limit: 100 });
  });

  it('caps the page size at 100', () => {
    expect(auditLogQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('applies the same range rules as statistics', () => {
    expect(auditLogQuerySchema.safeParse({ from: '2026-03-10', to: '2026-03-09' }).success).toBe(
      false,
    );
    expect(auditLogQuerySchema.safeParse({ from: '2026-01-01', to: '2026-04-03' }).success).toBe(
      false,
    );
  });

  it('refuses empty or very long text filters', () => {
    expect(auditLogQuerySchema.safeParse({ action: '' }).success).toBe(false);
    expect(auditLogQuerySchema.safeParse({ action: 'x'.repeat(101) }).success).toBe(false);
    expect(auditLogQuerySchema.safeParse({ actorId: '' }).success).toBe(false);
  });
});
