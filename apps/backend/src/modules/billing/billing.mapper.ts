import type {
  BillDto,
  BillLineDto,
  BillSummaryDto,
  BillTotalsDto,
  CreditNoteDto,
  InvoiceDto,
  PaymentDto,
} from '@hospitality/shared-types';
import { nightsOf } from '../../shared/dates';
import type { BillDocument, BillLineDocument } from './bill.model';
import type { CreditNoteDocument } from './credit-note.model';
import { summarise, type BillTotals } from './gst';
import type { PaymentDocument } from './payment.model';

const iso = (date: Date): string => date.toISOString();

/** A line added by hand is the only kind that can be removed from an open bill. */
export const isManualLine = (line: Pick<BillLineDocument, 'sourceKey'>): boolean =>
  line.sourceKey.startsWith('manual:');

/** An issued invoice shows the figures it was issued with; an open bill shows live totals. */
export function totalsOf(bill: BillDocument): BillTotals {
  return bill.invoice ? bill.invoice.totals : summarise(bill.lines);
}

export interface Balance {
  paidPaise: number;
  refundedPaise: number;
  creditNotePaise: number;
  /** What the guest still owes. Negative when they are owed money back. */
  balancePaise: number;
}

export function balanceOf(
  totals: BillTotals,
  payments: readonly Pick<PaymentDocument, 'kind' | 'amountPaise'>[],
  creditNotes: readonly Pick<CreditNoteDocument, 'totalPaise'>[],
): Balance {
  let paid = 0;
  let refunded = 0;
  for (const payment of payments) {
    if (payment.kind === 'payment') paid += payment.amountPaise;
    else refunded += payment.amountPaise;
  }
  const creditNotePaise = creditNotes.reduce((sum, note) => sum + note.totalPaise, 0);
  return {
    paidPaise: paid,
    refundedPaise: refunded,
    creditNotePaise,
    balancePaise: totals.totalPaise - creditNotePaise - (paid - refunded),
  };
}

export function toPaymentDto(payment: PaymentDocument): PaymentDto {
  return {
    id: payment._id.toHexString(),
    billId: payment.billId.toHexString(),
    bookingId: payment.bookingId.toHexString(),
    bookingCode: payment.bookingCode,
    guestName: payment.guestName,
    kind: payment.kind,
    method: payment.method,
    amountPaise: payment.amountPaise,
    reference: payment.reference,
    reason: payment.reason,
    recordedBy: payment.recordedBy,
    createdAt: iso(payment.createdAt),
  };
}

export function toCreditNoteDto(note: CreditNoteDocument): CreditNoteDto {
  return {
    id: note._id.toHexString(),
    number: note.number,
    invoiceNumber: note.invoiceNumber,
    lineId: note.lineId,
    description: note.description,
    taxablePaise: note.taxablePaise,
    cgstPaise: note.cgstPaise,
    sgstPaise: note.sgstPaise,
    igstPaise: note.igstPaise,
    taxPaise: note.taxPaise,
    totalPaise: note.totalPaise,
    reason: note.reason,
    issuedBy: note.issuedBy,
    issuedAt: iso(note.issuedAt),
  };
}

function toLineDto(line: BillLineDocument, creditNumbers: Map<string, string>): BillLineDto {
  return {
    id: line.lineId,
    kind: line.kind,
    category: line.category,
    description: line.description,
    serviceDate: line.serviceDate,
    quantity: line.quantity,
    unitPaise: line.unitPaise,
    taxablePaise: line.taxablePaise,
    ratePercent: line.ratePercent,
    cgstPaise: line.cgstPaise,
    sgstPaise: line.sgstPaise,
    igstPaise: line.igstPaise,
    taxPaise: line.taxPaise,
    totalPaise: line.totalPaise,
    sacCode: line.sacCode,
    reason: line.reason,
    approvedBy: line.approvedBy,
    manual: isManualLine(line),
    creditNoteNumber: creditNumbers.get(line.lineId) ?? null,
    postedAt: iso(line.postedAt),
  };
}

const totalsDto = (totals: BillTotals): BillTotalsDto => ({ ...totals });

function toInvoiceDto(bill: BillDocument): InvoiceDto | null {
  if (!bill.invoice) return null;
  return {
    number: bill.invoice.number,
    financialYear: bill.invoice.financialYear,
    issuedAt: iso(bill.invoice.issuedAt),
    supplier: { ...bill.invoice.supplier },
    placeOfSupplyState: bill.invoice.placeOfSupplyState,
    intraState: bill.invoice.intraState,
    totals: totalsDto(bill.invoice.totals),
  };
}

export function toBillDto(
  bill: BillDocument,
  payments: readonly PaymentDocument[],
  creditNotes: readonly CreditNoteDocument[],
): BillDto {
  const totals = totalsOf(bill);
  const balance = balanceOf(totals, payments, creditNotes);
  const creditNumbers = new Map(creditNotes.map((note) => [note.lineId, note.number]));
  return {
    id: bill._id.toHexString(),
    bookingId: bill.bookingId.toHexString(),
    bookingCode: bill.bookingCode,
    guest: { name: bill.guestName, phone: bill.guestPhone, gstin: bill.guestGstin },
    roomNumber: bill.roomNumber,
    checkInDate: bill.checkInDate,
    checkOutDate: bill.checkOutDate,
    nights: nightsOf(bill.checkInDate, bill.checkOutDate).length,
    status: bill.status,
    lines: bill.lines.map((line) => toLineDto(line, creditNumbers)),
    totals: totalsDto(totals),
    ...balance,
    payments: payments.map(toPaymentDto),
    creditNotes: creditNotes.map(toCreditNoteDto),
    invoice: toInvoiceDto(bill),
    createdAt: iso(bill.createdAt),
    updatedAt: iso(bill.updatedAt),
  };
}

export function toBillSummary(bill: BillDocument, balance: Balance): BillSummaryDto {
  return {
    id: bill._id.toHexString(),
    bookingId: bill.bookingId.toHexString(),
    bookingCode: bill.bookingCode,
    guestName: bill.guestName,
    roomNumber: bill.roomNumber,
    status: bill.status,
    invoiceNumber: bill.invoice?.number ?? null,
    totalPaise: totalsOf(bill).totalPaise,
    balancePaise: balance.balancePaise,
    createdAt: iso(bill.createdAt),
  };
}
