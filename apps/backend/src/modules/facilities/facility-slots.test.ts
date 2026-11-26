import { describe, expect, it } from 'vitest';
import { buildSlots, findSlot } from './facility-slots';

describe('buildSlots', () => {
  it('lays slots end to end from opening time, in steps of the slot length', () => {
    expect(buildSlots('09:00', '12:00', 60)).toEqual([
      { startTime: '09:00', endTime: '10:00' },
      { startTime: '10:00', endTime: '11:00' },
      { startTime: '11:00', endTime: '12:00' },
    ]);
  });

  it('drops a last slot that would run past closing time', () => {
    expect(buildSlots('09:00', '11:30', 60).map((s) => s.startTime)).toEqual(['09:00', '10:00']);
  });

  it('handles odd lengths, minutes and a day that ends at 23:59', () => {
    expect(buildSlots('06:30', '08:15', 45)).toEqual([
      { startTime: '06:30', endTime: '07:15' },
      { startTime: '07:15', endTime: '08:00' },
    ]);
    expect(buildSlots('22:00', '23:59', 60)).toEqual([{ startTime: '22:00', endTime: '23:00' }]);
  });

  it('gives no slots when the opening hours cannot hold one', () => {
    expect(buildSlots('09:00', '09:30', 60)).toEqual([]);
    expect(buildSlots('10:00', '09:00', 30)).toEqual([]);
  });

  it('pads single-digit hours', () => {
    expect(buildSlots('00:00', '02:00', 60)[0]).toEqual({ startTime: '00:00', endTime: '01:00' });
  });
});

describe('findSlot', () => {
  const facility = { opensAt: '09:00', closesAt: '12:00', slotMinutes: 60 };

  it('finds the slot that starts at a given time', () => {
    expect(findSlot(facility, '10:00')).toEqual({ startTime: '10:00', endTime: '11:00' });
  });

  it('refuses a time that is not the start of a slot', () => {
    expect(findSlot(facility, '10:30')).toBeNull();
    expect(findSlot(facility, '08:00')).toBeNull();
    expect(findSlot(facility, '12:00')).toBeNull();
  });
});
