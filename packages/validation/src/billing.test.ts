import { MAX_BILL_AMOUNT_PAISE } from '@hospitality/constants';
import { describe, expect, it } from 'vitest';
import {
  addBillLineSchema,
  checkOutSchema,
  creditNoteSchema,
  listBillsQuerySchema,
  listPaymentsQuerySchema,
  paymentsSummaryQuerySchema,
  recordPaymentSchema,
  refundSchema,
} from './billing';

const ID = '0123456789abcdef01234567';

describe('addBillLineSchema', () => {
  const valid = {
    kind: 'charge',
    category: 'other',
    description: 'Laundry',
    amountPaise: 25_000,
    reason: 'Guest asked for same-day laundry',
  };

  it('accepts a charge and fills the quantity', () => {
    expect(addBillLineSchema.parse(valid)).toEqual({ ...valid, quantity: 1 });
  });

  it('accepts a discount in any manual category', () => {
    for (const category of ['food', 'spa_recreation', 'other']) {
      expect(addBillLineSchema.safeParse({ ...valid, kind: 'discount', category }).success).toBe(
        true,
      );
    }
  });

  it.each([
    ['a kind that is not charge or discount', { kind: 'room' }],
    ['the room category (room tax follows the booking)', { category: 'room' }],
    ['no description', { description: ' ' }],
    ['a negative amount (a discount is a positive amount with kind discount)', { amountPaise: -5 }],
    ['a zero amount', { amountPaise: 0 }],
    ['a fractional amount', { amountPaise: 10.5 }],
    ['an amount above the limit', { amountPaise: MAX_BILL_AMOUNT_PAISE + 1 }],
    ['a quantity of zero', { quantity: 0 }],
    ['a quantity above 100', { quantity: 101 }],
    ['no reason', { reason: '' }],
    ['a one-letter reason', { reason: 'x' }],
  ])('rejects %s', (_label, change) => {
    expect(addBillLineSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it('never takes a tax rate, tax amount or total from the client', () => {
    const parsed = addBillLineSchema.parse({
      ...valid,
      ratePercent: 0,
      taxPaise: 0,
      totalPaise: 1,
      sacCode: '000000',
    });
    for (const key of ['ratePercent', 'taxPaise', 'totalPaise', 'sacCode']) {
      expect(parsed).not.toHaveProperty(key);
    }
  });
});

describe('recordPaymentSchema', () => {
  it('accepts a payment and fills an empty reference', () => {
    expect(recordPaymentSchema.parse({ method: 'upi', amountPaise: 50_000 })).toEqual({
      method: 'upi',
      amountPaise: 50_000,
      reference: '',
    });
    expect(
      recordPaymentSchema.parse({ method: 'card', amountPaise: 100, reference: ' TXN 123 ' }),
    ).toMatchObject({ reference: 'TXN 123' });
  });

  it.each([
    ['an unknown method', { method: 'bitcoin' }],
    ['a zero amount', { amountPaise: 0 }],
    ['a negative amount', { amountPaise: -1 }],
    ['a fractional amount', { amountPaise: 99.5 }],
    ['an amount above the limit', { amountPaise: MAX_BILL_AMOUNT_PAISE * 11 }],
    ['a reference that is too long', { reference: 'x'.repeat(61) }],
  ])('rejects %s', (_label, change) => {
    expect(
      recordPaymentSchema.safeParse({ method: 'cash', amountPaise: 100, ...change }).success,
    ).toBe(false);
  });
});

describe('refundSchema, creditNoteSchema and checkOutSchema', () => {
  it('needs a method, an amount and a reason to refund', () => {
    expect(
      refundSchema.parse({ method: 'cash', amountPaise: 5_000, reason: ' Overcharged ' }),
    ).toEqual({ method: 'cash', amountPaise: 5_000, reason: 'Overcharged' });
    expect(refundSchema.safeParse({ method: 'cash', amountPaise: 5_000 }).success).toBe(false);
    expect(
      refundSchema.safeParse({ method: 'cash', amountPaise: 0, reason: 'x y z' }).success,
    ).toBe(false);
  });

  it('needs a line id and a reason for a credit note', () => {
    expect(creditNoteSchema.parse({ lineId: 'line-1', reason: 'Wrong item' })).toEqual({
      lineId: 'line-1',
      reason: 'Wrong item',
    });
    expect(creditNoteSchema.safeParse({ lineId: '', reason: 'Wrong item' }).success).toBe(false);
    expect(creditNoteSchema.safeParse({ lineId: 'line-1' }).success).toBe(false);
  });

  it('lets check-out carry an optional override reason, and nothing else', () => {
    expect(checkOutSchema.parse({})).toEqual({});
    expect(checkOutSchema.parse({ overrideReason: ' Guest will transfer tomorrow ' })).toEqual({
      overrideReason: 'Guest will transfer tomorrow',
    });
    expect(checkOutSchema.safeParse({ overrideReason: 'x' }).success).toBe(false);
    expect(checkOutSchema.parse({ balancePaise: 0, force: true })).toEqual({});
  });
});

describe('list schemas', () => {
  it('parses bill list filters from a query string', () => {
    expect(
      listBillsQuerySchema.parse({ status: 'open', bookingId: ID, limit: '10' }),
    ).toMatchObject({
      status: 'open',
      bookingId: ID,
      limit: 10,
      page: 1,
    });
    expect(listBillsQuerySchema.safeParse({ status: 'paid' }).success).toBe(false);
    expect(listBillsQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('parses ledger filters and a summary date', () => {
    expect(
      listPaymentsQuerySchema.parse({ date: '2026-03-12', method: 'cash', kind: 'refund' }),
    ).toMatchObject({ date: '2026-03-12', method: 'cash', kind: 'refund' });
    expect(listPaymentsQuerySchema.safeParse({ method: 'bitcoin' }).success).toBe(false);
    expect(listPaymentsQuerySchema.safeParse({ date: '2026-02-30' }).success).toBe(false);
    expect(paymentsSummaryQuerySchema.parse({ date: '2026-03-12' })).toEqual({
      date: '2026-03-12',
    });
    expect(paymentsSummaryQuerySchema.safeParse({}).success).toBe(false);
  });
});
