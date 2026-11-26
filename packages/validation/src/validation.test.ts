import { describe, expect, it } from 'vitest';
import { changePasswordSchema, passwordSchema, staffLoginSchema } from './auth';
import { paginationSchema } from './common';
import { normalizePhone, phoneSchema } from './phone';
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
