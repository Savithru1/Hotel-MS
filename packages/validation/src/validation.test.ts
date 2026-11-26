import { describe, expect, it } from 'vitest';
import { changePasswordSchema, passwordSchema, staffLoginSchema } from './auth';
import { paginationSchema } from './common';
import { createGuestSchema } from './guests';
import { normalizePhone, phoneSchema } from './phone';
import {
  dateOnlySchema,
  gstRuleSetSchema,
  gstinSchema,
  timeOfDaySchema,
  timezoneSchema,
} from './property';
import {
  createRoomTypeSchema,
  ratePaiseSchema,
  roomNumberSchema,
  setRoomStatusSchema,
} from './rooms';
import { createStaffSchema, listStaffQuerySchema, updateStaffSchema } from './staff';

describe('normalizePhone', () => {
  it.each([
    ['98765 43210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['  9876543210  ', '+919876543210'],
    ['+44 7911 123456', '+447911123456'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', '   ', '12345', 'not a number', '+91 12345', '9'.repeat(40)])(
    'rejects %j',
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );

  it('gives the same result for every way of writing one number', () => {
    expect(normalizePhone('9876543210')).toBe(normalizePhone('+91 (98765) 43210'));
  });
});

describe('phoneSchema', () => {
  it('outputs the normalised number', () => {
    expect(phoneSchema.parse('98765 43210')).toBe('+919876543210');
  });
  it('fails with a message that does not echo the input', () => {
    const result = phoneSchema.safeParse('abc');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('abc');
  });
});

describe('passwordSchema', () => {
  it('accepts a reasonable password', () => {
    expect(passwordSchema.safeParse('correct horse 9').success).toBe(true);
  });
  it.each(['short1', 'onlyletterslong', '1234567890123', 'a1'.repeat(40)])('rejects %s', (v) => {
    expect(passwordSchema.safeParse(v).success).toBe(false);
  });
  it('counts bytes, not characters, against the bcrypt limit', () => {
    expect(passwordSchema.safeParse('é'.repeat(40) + '12345').success).toBe(false);
  });
});

describe('staffLoginSchema', () => {
  it('normalises the slug and email', () => {
    const parsed = staffLoginSchema.parse({
      propertySlug: ' Grand-Plaza ',
      email: ' Front.Desk@Example.COM ',
      password: 'x',
    });
    expect(parsed).toEqual({
      propertySlug: 'grand-plaza',
      email: 'front.desk@example.com',
      password: 'x',
    });
  });
  it('rejects a bad slug', () => {
    expect(
      staffLoginSchema.safeParse({ propertySlug: '../x', email: 'a@b.co', password: 'x' }).success,
    ).toBe(false);
  });
});

describe('changePasswordSchema', () => {
  it('checks the strength of the new password only', () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'weak' }).success,
    ).toBe(false);
  });
});

describe('createStaffSchema', () => {
  it('drops fields the client must never set', () => {
    const parsed = createStaffSchema.parse({
      name: 'Asha',
      email: 'asha@example.com',
      role: 'front_desk',
      propertyId: '65f000000000000000000000',
      passwordHash: 'x',
      active: false,
    });
    expect(parsed).toEqual({ name: 'Asha', email: 'asha@example.com', role: 'front_desk' });
  });
  it('refuses platform_admin as a role', () => {
    expect(
      createStaffSchema.safeParse({ name: 'A', email: 'a@b.co', role: 'platform_admin' }).success,
    ).toBe(false);
  });
  it('removes duplicate departments', () => {
    const parsed = createStaffSchema.parse({
      name: 'A',
      email: 'a@b.co',
      role: 'manager',
      departments: ['kitchen', 'kitchen'],
    });
    expect(parsed.departments).toEqual(['kitchen']);
  });
});

describe('updateStaffSchema', () => {
  it('needs at least one change', () => {
    expect(updateStaffSchema.safeParse({}).success).toBe(false);
    expect(updateStaffSchema.safeParse({ active: false }).success).toBe(true);
  });
});

describe('pagination', () => {
  it('has defaults and a cap', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, limit: 25 });
    expect(paginationSchema.safeParse({ limit: '1000' }).success).toBe(false);
  });
  it('parses list filters from strings', () => {
    expect(listStaffQuerySchema.parse({ active: 'false', page: '2' })).toMatchObject({
      active: false,
      page: 2,
    });
  });
});

describe('property, room and guest schemas', () => {
  it('accepts a real GSTIN and uppercases it', () => {
    expect(gstinSchema.parse('27abcde1234f1z5')).toBe('27ABCDE1234F1Z5');
    expect(gstinSchema.safeParse('27ABCDE1234F1Z').success).toBe(false);
  });

  it('rejects dates that only exist after rolling over (31 February)', () => {
    for (const bad of ['2026-02-31', '2026-04-31', '2027-02-29', '2026-13-01']) {
      expect(dateOnlySchema.safeParse(bad).success, bad).toBe(false);
    }
    for (const good of ['2026-02-28', '2028-02-29', '2026-12-31']) {
      expect(dateOnlySchema.safeParse(good).success, good).toBe(true);
    }
  });

  it('checks timezones and times', () => {
    expect(timezoneSchema.safeParse('Asia/Kolkata').success).toBe(true);
    expect(timezoneSchema.safeParse('Not/AZone').success).toBe(false);
    expect(timeOfDaySchema.safeParse('09:30').success).toBe(true);
    expect(timeOfDaySchema.safeParse('9:30').success).toBe(false);
  });

  it('only accepts whole-paise tariffs within range', () => {
    expect(ratePaiseSchema.safeParse(250_000).success).toBe(true);
    for (const bad of [-1, 0.5, '100', Number.NaN, 60_000_000]) {
      expect(ratePaiseSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('keeps room numbers as typed labels', () => {
    expect(roomNumberSchema.parse(' 204 ')).toBe('204');
    expect(roomNumberSchema.safeParse('B-12').success).toBe(true);
    expect(roomNumberSchema.safeParse('<script>').success).toBe(false);
  });

  it('removes duplicate amenities and unknown fields from a room type', () => {
    const parsed = createRoomTypeSchema.parse({
      name: 'Deluxe',
      capacity: 2,
      ratePaise: 1000,
      amenities: ['TV', 'TV'],
      propertyId: 'x',
    });
    expect(parsed).toEqual({ name: 'Deluxe', capacity: 2, ratePaise: 1000, amenities: ['TV'] });
  });

  it('only allows the manual room statuses', () => {
    expect(setRoomStatusSchema.safeParse({ status: 'cleaning' }).success).toBe(true);
    expect(setRoomStatusSchema.safeParse({ status: 'occupied' }).success).toBe(false);
  });

  it('normalises the phone in a guest record', () => {
    expect(createGuestSchema.parse({ name: 'A B', phone: '98765 43210' }).phone).toBe(
      '+919876543210',
    );
  });

  it('requires GST slabs to rise and end unlimited', () => {
    const rules = {
      effectiveFrom: '2027-04-01',
      room: {
        slabs: [
          { upToPaise: 100, ratePercent: 5 },
          { upToPaise: null, ratePercent: 18 },
        ],
      },
      food: { ratePercent: 5, highTariffThresholdPaise: 750_000, highTariffRatePercent: 18 },
      spaRecreation: { ratePercent: 18 },
      other: { ratePercent: 18 },
    };
    expect(gstRuleSetSchema.safeParse(rules).success).toBe(true);
    expect(
      gstRuleSetSchema.safeParse({
        ...rules,
        room: { slabs: [{ upToPaise: 100, ratePercent: 5 }] },
      }).success,
    ).toBe(false);
  });
});
