import {
  BILL_STATUSES,
  MANUAL_LINE_CATEGORIES,
  MAX_BILL_AMOUNT_PAISE,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
} from '@hospitality/constants';
import { z } from 'zod';
import { objectIdSchema, paginationSchema, shortText } from './common';
import { dateOnlySchema } from './property';

/** A payment may be larger than a single manual line: a whole stay can be settled at once. */
const MAX_PAYMENT_PAISE = MAX_BILL_AMOUNT_PAISE * 10;

const reason = z.string().trim().min(3, 'please give a reason').max(200);
const amount = (max: number) => z.number().int().min(1).max(max);

/**
 * A charge or discount added by hand. The amount is always positive: `kind` says which way it
 * goes. There is deliberately no tax rate, tax amount, total or SAC code here, because the server
 * works out the tax from the property's rules.
 */
export const addBillLineSchema = z.object({
  kind: z.enum(['charge', 'discount']),
  category: z.enum(MANUAL_LINE_CATEGORIES),
  description: shortText(120),
  /** Per unit, before tax, in paise. */
  amountPaise: amount(MAX_BILL_AMOUNT_PAISE),
  quantity: z.number().int().min(1).max(100).default(1),
  reason,
});

export const recordPaymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountPaise: amount(MAX_PAYMENT_PAISE),
  /** A card slip number, UPI reference or similar, for the ledger. */
  reference: z.string().trim().max(60).default(''),
});

export const refundSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountPaise: amount(MAX_PAYMENT_PAISE),
  reason,
});

export const creditNoteSchema = z.object({
  lineId: shortText(60),
  reason,
});

/** Check-out takes no figures at all; an override reason is only for settling with money owed. */
export const checkOutSchema = z.object({
  overrideReason: reason.optional(),
});

export const listBillsQuerySchema = paginationSchema.extend({
  status: z.enum(BILL_STATUSES).optional(),
  bookingId: objectIdSchema.optional(),
});

export const listPaymentsQuerySchema = paginationSchema.extend({
  date: dateOnlySchema.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  kind: z.enum(PAYMENT_KINDS).optional(),
  billId: objectIdSchema.optional(),
  bookingId: objectIdSchema.optional(),
});

export const paymentsSummaryQuerySchema = z.object({ date: dateOnlySchema });

/** `/bills/:id/lines/:lineId` */
export const billLineParamsSchema = z.object({ id: objectIdSchema, lineId: shortText(60) });

/** `/bills/by-booking/:bookingId` */
export const bookingIdParamsSchema = z.object({ bookingId: objectIdSchema });
