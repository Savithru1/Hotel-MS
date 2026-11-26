import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isDateOnly, nightsOf, todayIn } from './dates';

describe('isDateOnly', () => {
  it.each(['2026-03-12', '2024-02-29'])('accepts %s', (value) => {
    expect(isDateOnly(value)).toBe(true);
  });
  it.each([
    '2026-02-30',
    '2026-13-01',
    '26-03-12',
    '2026-3-2',
    '2026-03-12T00:00:00Z',
    '',
    'today',
  ])('rejects %s', (value) => {
    expect(isDateOnly(value)).toBe(false);
  });
});

describe('date arithmetic', () => {
  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDays('2026-03-31', 1)).toBe('2026-04-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-03-12', '2026-03-14')).toBe(2);
    expect(daysBetween('2026-03-14', '2026-03-12')).toBe(-2);
    expect(daysBetween('2026-03-12', '2026-03-12')).toBe(0);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('nightsOf', () => {
  it('lists each night from check-in up to, not including, check-out', () => {
    expect(nightsOf('2026-03-12', '2026-03-15')).toEqual([
      '2026-03-12',
      '2026-03-13',
      '2026-03-14',
    ]);
  });

  it('gives no nights for a zero or negative stay', () => {
    expect(nightsOf('2026-03-12', '2026-03-12')).toEqual([]);
    expect(nightsOf('2026-03-12', '2026-03-10')).toEqual([]);
  });

  it('makes back-to-back stays share no night', () => {
    const first = nightsOf('2026-03-12', '2026-03-14');
    const second = nightsOf('2026-03-14', '2026-03-16');
    expect(first.filter((night) => second.includes(night))).toEqual([]);
  });

  it('is unaffected by daylight saving changes', () => {
    expect(nightsOf('2026-03-07', '2026-03-10')).toHaveLength(3);
    expect(nightsOf('2026-10-30', '2026-11-03')).toHaveLength(4);
  });
});

describe('todayIn', () => {
  // 19:00 UTC on 25 November is already 00:30 on 26 November in India.
  const instant = new Date('2026-11-25T19:00:00Z');

  it('uses the property timezone, not the server clock', () => {
    expect(todayIn('Asia/Kolkata', instant)).toBe('2026-11-26');
    expect(todayIn('UTC', instant)).toBe('2026-11-25');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-11-25');
    expect(todayIn('Pacific/Auckland', instant)).toBe('2026-11-26');
  });

  it('switches over at local midnight', () => {
    expect(todayIn('Asia/Kolkata', new Date('2026-11-25T18:29:59Z'))).toBe('2026-11-25');
    expect(todayIn('Asia/Kolkata', new Date('2026-11-25T18:30:00Z'))).toBe('2026-11-26');
  });

  it('follows daylight saving in the property’s timezone', () => {
    expect(todayIn('America/New_York', new Date('2026-03-08T06:59:00Z'))).toBe('2026-03-08');
  });
});
