import { describe, expect, it } from 'vitest';
import {
  cancelFacilityBookingSchema,
  createFacilityBookingSchema,
  createFacilitySchema,
  listFacilityBookingsQuerySchema,
  slotsQuerySchema,
  updateFacilitySchema,
} from './facilities';

const ID = '0123456789abcdef01234567';

const validFacility = {
  name: 'Ayurvedic Spa',
  type: 'spa',
  capacity: 1,
  slotMinutes: 60,
  opensAt: '09:00',
  closesAt: '20:00',
  pricePaise: 150_000,
};

describe('createFacilitySchema', () => {
  it('accepts a facility and fills the defaults', () => {
    expect(createFacilitySchema.parse(validFacility)).toEqual({
      ...validFacility,
      description: '',
      active: true,
    });
  });

  it('allows a free facility such as the pool or gym', () => {
    expect(createFacilitySchema.safeParse({ ...validFacility, pricePaise: 0 }).success).toBe(true);
  });

  it.each([
    ['an empty name', { name: ' ' }],
    ['an unknown type', { type: 'casino' }],
    ['zero capacity', { capacity: 0 }],
    ['capacity above the limit', { capacity: 101 }],
    ['a fractional capacity', { capacity: 1.5 }],
    ['a slot shorter than 15 minutes', { slotMinutes: 10 }],
    ['a slot longer than 8 hours', { slotMinutes: 600 }],
    ['a slot length that is not a multiple of 5', { slotMinutes: 47 }],
    ['an opening time that is not HH:mm', { opensAt: '9am' }],
    ['a closing time with bad minutes', { closesAt: '20:75' }],
    ['closing at or before opening', { opensAt: '20:00', closesAt: '20:00' }],
    ['closing before opening', { opensAt: '20:00', closesAt: '09:00' }],
    ['no room for a single slot', { opensAt: '09:00', closesAt: '09:30', slotMinutes: 60 }],
    ['a negative price', { pricePaise: -1 }],
    ['a fractional price', { pricePaise: 10.5 }],
    ['a price above the limit', { pricePaise: 99_999_999_999 }],
  ])('rejects %s', (_label, change) => {
    expect(createFacilitySchema.safeParse({ ...validFacility, ...change }).success).toBe(false);
  });

  it('ignores a property id or an id sent by the client', () => {
    const parsed = createFacilitySchema.parse({ ...validFacility, propertyId: ID, _id: ID });
    expect(parsed).not.toHaveProperty('propertyId');
    expect(parsed).not.toHaveProperty('_id');
  });
});

describe('updateFacilitySchema', () => {
  it('accepts a partial change without resetting anything else', () => {
    expect(updateFacilitySchema.parse({ pricePaise: 100 })).toEqual({ pricePaise: 100 });
    expect(updateFacilitySchema.parse({ active: false })).toEqual({ active: false });
  });

  it('refuses an empty change and applies the same limits', () => {
    expect(updateFacilitySchema.safeParse({}).success).toBe(false);
    expect(updateFacilitySchema.safeParse({ capacity: 0 }).success).toBe(false);
    expect(updateFacilitySchema.safeParse({ opensAt: '25:00' }).success).toBe(false);
  });
});

describe('slotsQuerySchema', () => {
  it('takes a real calendar date', () => {
    expect(slotsQuerySchema.parse({ date: '2026-03-12' })).toEqual({ date: '2026-03-12' });
    expect(slotsQuerySchema.safeParse({ date: '2026-02-30' }).success).toBe(false);
    expect(slotsQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('createFacilityBookingSchema', () => {
  const booking = { facilityId: ID, roomId: ID, date: '2026-03-12', startTime: '10:00' };

  it('accepts a booking for a room and fills the defaults', () => {
    expect(createFacilityBookingSchema.parse(booking)).toEqual({
      ...booking,
      participants: 1,
      notes: '',
    });
  });

  it('never takes a price, status or booking id from the client', () => {
    const parsed = createFacilityBookingSchema.parse({
      ...booking,
      pricePaise: 1,
      totalPaise: 1,
      status: 'completed',
      bookingId: ID,
    });
    for (const key of ['pricePaise', 'totalPaise', 'status', 'bookingId']) {
      expect(parsed).not.toHaveProperty(key);
    }
  });

  it.each([
    ['a bad facility id', { facilityId: 'nope' }],
    ['a bad room id', { roomId: 'nope' }],
    ['an impossible date', { date: '2026-02-30' }],
    ['a start time that is not HH:mm', { startTime: '10' }],
    ['zero participants', { participants: 0 }],
    ['too many participants', { participants: 101 }],
    ['fractional participants', { participants: 1.5 }],
    ['notes that are too long', { notes: 'x'.repeat(301) }],
  ])('rejects %s', (_label, change) => {
    expect(createFacilityBookingSchema.safeParse({ ...booking, ...change }).success).toBe(false);
  });
});

describe('list and cancel schemas', () => {
  it('parses booking list filters from a query string', () => {
    expect(
      listFacilityBookingsQuerySchema.parse({ date: '2026-03-12', open: 'true', limit: '10' }),
    ).toMatchObject({ date: '2026-03-12', open: true, limit: 10, page: 1 });
    expect(listFacilityBookingsQuerySchema.safeParse({ status: 'burnt' }).success).toBe(false);
    expect(listFacilityBookingsQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('needs a reason to cancel', () => {
    expect(cancelFacilityBookingSchema.parse({ reason: ' Guest unwell ' })).toEqual({
      reason: 'Guest unwell',
    });
    expect(cancelFacilityBookingSchema.safeParse({}).success).toBe(false);
    expect(cancelFacilityBookingSchema.safeParse({ reason: 'x' }).success).toBe(false);
  });
});
