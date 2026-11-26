import { describe, expect, it } from 'vitest';
import {
  buildChargePayload,
  buildPaymentPayload,
  buildRefundPayload,
  emptyChargeForm,
  needsManager,
} from './billing-form';

const charge = (over: Partial<ReturnType<typeof emptyChargeForm>> = {}) => ({
  ...emptyChargeForm(),
  description: 'Laundry',
  amount: '250',
  reason: 'Guest request',
  ...over,
});

describe('buildChargePayload', () => {
  it('turns rupees into whole paise without rounding errors', () => {
    const result = buildChargePayload(charge({ amount: '19.99', quantity: '3' }));
    expect(result).toMatchObject({ ok: true, value: { amountPaise: 1999, quantity: 3 } });
  });

  it('accepts commas, and keeps the kind and category', () => {
    const result = buildChargePayload(
      charge({ amount: '1,250', kind: 'discount', category: 'food' }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { amountPaise: 125_000, kind: 'discount', category: 'food' },
    });
  });

  it.each([
    ['no description', { description: '  ' }],
    ['a blank amount', { amount: '' }],
    ['a zero amount', { amount: '0' }],
    ['a negative amount', { amount: '-5' }],
    ['text instead of an amount', { amount: 'abc' }],
    ['three decimals', { amount: '1.234' }],
    ['an amount far too large', { amount: '99999999' }],
    ['a fractional quantity', { quantity: '1.5' }],
    ['a zero quantity', { quantity: '0' }],
    ['a huge quantity', { quantity: '101' }],
    ['no reason', { reason: '' }],
    ['a too short reason', { reason: 'ok' }],
  ])('refuses %s', (_name, over) => {
    const result = buildChargePayload(charge(over));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(5);
  });
});

describe('needsManager', () => {
  it('is false up to the approval limit and true above it', () => {
    expect(needsManager({ amountPaise: 500_000, quantity: 1 })).toBe(false);
    expect(needsManager({ amountPaise: 500_001, quantity: 1 })).toBe(true);
    expect(needsManager({ amountPaise: 250_000, quantity: 3 })).toBe(true);
  });
});

describe('buildPaymentPayload', () => {
  const form = { method: 'upi' as const, amount: '1000', reference: ' UTR 42 ' };

  it('accepts up to the balance and trims the reference', () => {
    expect(buildPaymentPayload(form, 100_000)).toEqual({
      ok: true,
      value: { method: 'upi', amountPaise: 100_000, reference: 'UTR 42' },
    });
  });

  it('refuses more than is owed, naming the balance', () => {
    const result = buildPaymentPayload(form, 99_999);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('999.99');
  });

  it('refuses a payment when nothing is owed', () => {
    expect(buildPaymentPayload(form, 0).ok).toBe(false);
    expect(buildPaymentPayload(form, -500).ok).toBe(false);
  });

  it('refuses a missing or invalid amount', () => {
    expect(buildPaymentPayload({ ...form, amount: '' }, 100_000).ok).toBe(false);
    expect(buildPaymentPayload({ ...form, amount: '0' }, 100_000).ok).toBe(false);
  });
});

describe('buildRefundPayload', () => {
  const form = { method: 'cash' as const, amount: '200', reason: 'Goodwill' };

  it('accepts up to what was paid and not yet refunded', () => {
    expect(buildRefundPayload(form, 20_000)).toEqual({
      ok: true,
      value: { method: 'cash', amountPaise: 20_000, reason: 'Goodwill' },
    });
  });

  it('refuses more than was paid', () => {
    expect(buildRefundPayload(form, 19_999).ok).toBe(false);
  });

  it('needs a real reason', () => {
    expect(buildRefundPayload({ ...form, reason: 'no' }, 20_000).ok).toBe(false);
  });
});
