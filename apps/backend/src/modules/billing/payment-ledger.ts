import type { PaymentKind, PaymentMethod } from '@hospitality/constants';
import type { PaymentDto, PaymentsSummaryDto } from '@hospitality/shared-types';
import { addDays, localDateTimeToUtc } from '../../shared/dates';
import type { PropertyDocument } from '../properties/property.model';
import { toPaymentDto } from './billing.mapper';
import { Payment } from './payment.model';

export interface ListPaymentsInput {
  page: number;
  limit: number;
  date?: string | undefined;
  method?: PaymentMethod | undefined;
  kind?: PaymentKind | undefined;
  billId?: string | undefined;
  bookingId?: string | undefined;
}

export interface PaymentLedger {
  payments(input: ListPaymentsInput): Promise<{ items: PaymentDto[]; total: number }>;
  paymentsSummary(date: string): Promise<PaymentsSummaryDto>;
}

/** The start and end of a calendar day in the property's timezone, as instants. */
function dayRange(date: string, timezone: string): { from: Date; to: Date } {
  return {
    from: localDateTimeToUtc(date, '00:00', timezone),
    to: localDateTimeToUtc(addDays(date, 1), '00:00', timezone),
  };
}

/** Read-only views over the payments collection: the ledger and a day's totals. */
export function createPaymentLedger(
  property: () => Promise<Pick<PropertyDocument, 'timezone'>>,
): PaymentLedger {
  return {
    async payments(input) {
      const filter: Record<string, unknown> = {};
      if (input.method) filter.method = input.method;
      if (input.kind) filter.kind = input.kind;
      if (input.billId) filter.billId = input.billId;
      if (input.bookingId) filter.bookingId = input.bookingId;
      if (input.date) {
        const { from, to } = dayRange(input.date, (await property()).timezone);
        filter.createdAt = { $gte: from, $lt: to };
      }
      const [rows, total] = await Promise.all([
        Payment.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        Payment.countDocuments(filter),
      ]);
      return { items: rows.map(toPaymentDto), total };
    },

    async paymentsSummary(date) {
      const { from, to } = dayRange(date, (await property()).timezone);
      const rows = await Payment.aggregate<{
        _id: { method: PaymentMethod; kind: PaymentKind };
        total: number;
        count: number;
      }>([
        { $match: { createdAt: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: { method: '$method', kind: '$kind' },
            total: { $sum: '$amountPaise' },
            count: { $sum: 1 },
          },
        },
      ]);
      const netByMethod: Record<string, number> = {};
      let collected = 0;
      let refunded = 0;
      let count = 0;
      for (const row of rows) {
        const signed = row._id.kind === 'payment' ? row.total : -row.total;
        netByMethod[row._id.method] = (netByMethod[row._id.method] ?? 0) + signed;
        if (row._id.kind === 'payment') collected += row.total;
        else refunded += row.total;
        count += row.count;
      }
      return {
        date,
        netByMethod,
        collectedPaise: collected,
        refundedPaise: refunded,
        netPaise: collected - refunded,
        count,
      };
    },
  };
}
