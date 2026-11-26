import {
  MANUAL_APPROVAL_LIMIT_PAISE,
  MAX_BILL_AMOUNT_PAISE,
  type ManualLineCategory,
  type PaymentMethod,
} from '@hospitality/constants';
import { paiseToRupees, rupeesToPaise } from '../manager/menu-form';

export { paiseToRupees };

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = <T>(error: string): FormResult<T> => ({ ok: false, error });

export interface ChargeForm {
  kind: 'charge' | 'discount';
  category: ManualLineCategory;
  description: string;
  /** Per unit, in rupees as typed. */
  amount: string;
  quantity: string;
  reason: string;
}

export interface ChargePayload {
  kind: 'charge' | 'discount';
  category: ManualLineCategory;
  description: string;
  amountPaise: number;
  quantity: number;
  reason: string;
}

export function emptyChargeForm(): ChargeForm {
  return {
    kind: 'charge',
    category: 'other',
    description: '',
    amount: '',
    quantity: '1',
    reason: '',
  };
}

/** The amount typed in rupees, as whole paise, or a sentence saying what is wrong. */
function amountOf(text: string, max: number, noun: string): FormResult<number> {
  const paise = rupeesToPaise(text);
  if (paise === null || paise < 1)
    return fail(`Enter the ${noun} as an amount like 500 or 499.50.`);
  if (paise > max) return fail(`That ${noun} is too large. Check for a typo.`);
  return { ok: true, value: paise };
}

export function buildChargePayload(form: ChargeForm): FormResult<ChargePayload> {
  const description = form.description.trim();
  if (!description) return fail('Say what the charge is for, for example "Laundry".');
  const amount = amountOf(form.amount, MAX_BILL_AMOUNT_PAISE, 'amount');
  if (!amount.ok) return amount;
  const quantity = Number(form.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return fail('The quantity must be a whole number from 1 to 100.');
  }
  const reason = form.reason.trim();
  if (reason.length < 3) return fail('Give a reason, so the bill can be explained later.');
  return {
    ok: true,
    value: {
      kind: form.kind,
      category: form.category,
      description,
      amountPaise: amount.value,
      quantity,
      reason,
    },
  };
}

/** True when the line is big enough that only a manager may add it. The server enforces this too. */
export function needsManager(payload: Pick<ChargePayload, 'amountPaise' | 'quantity'>): boolean {
  return payload.amountPaise * payload.quantity > MANUAL_APPROVAL_LIMIT_PAISE;
}

export interface PaymentForm {
  method: PaymentMethod;
  amount: string;
  reference: string;
}

export interface PaymentPayload {
  method: PaymentMethod;
  amountPaise: number;
  reference: string;
}

/** A payment cannot be more than what is owed: the server refuses it as well. */
export function buildPaymentPayload(
  form: PaymentForm,
  balancePaise: number,
): FormResult<PaymentPayload> {
  const amount = amountOf(form.amount, MAX_BILL_AMOUNT_PAISE * 10, 'payment');
  if (!amount.ok) return amount;
  if (amount.value > balancePaise) {
    return fail(`That is more than the balance of ₹${paiseToRupees(Math.max(0, balancePaise))}.`);
  }
  return {
    ok: true,
    value: { method: form.method, amountPaise: amount.value, reference: form.reference.trim() },
  };
}

export interface RefundForm {
  method: PaymentMethod;
  amount: string;
  reason: string;
}

export interface RefundPayload {
  method: PaymentMethod;
  amountPaise: number;
  reason: string;
}

export function buildRefundPayload(
  form: RefundForm,
  refundablePaise: number,
): FormResult<RefundPayload> {
  const amount = amountOf(form.amount, MAX_BILL_AMOUNT_PAISE * 10, 'refund');
  if (!amount.ok) return amount;
  if (amount.value > refundablePaise) {
    return fail(
      `Only ₹${paiseToRupees(Math.max(0, refundablePaise))} has been paid and not yet refunded.`,
    );
  }
  const reason = form.reason.trim();
  if (reason.length < 3) return fail('Give a reason for the refund.');
  return { ok: true, value: { method: form.method, amountPaise: amount.value, reason } };
}

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  other: 'Other',
};

export const CATEGORY_LABELS: Record<ManualLineCategory, string> = {
  food: 'Food and drink',
  spa_recreation: 'Spa and recreation',
  other: 'Other services',
};
