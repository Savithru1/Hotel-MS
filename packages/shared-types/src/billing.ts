import type {
  BillLineKind,
  BillStatus,
  GstCategory,
  PaymentKind,
  PaymentMethod,
} from '@hospitality/constants';

/** One line of a bill, exactly as it was when posted. Tax figures are copies and never change. */
export interface BillLineDto {
  id: string;
  kind: BillLineKind;
  category: GstCategory;
  description: string;
  /** The date the service was supplied, `YYYY-MM-DD` in the property's timezone. */
  serviceDate: string;
  quantity: number;
  /** Per unit, before tax, in paise. */
  unitPaise: number;
  /** The value tax is charged on, in paise. Negative for a discount. */
  taxablePaise: number;
  ratePercent: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  /** Taxable value plus tax. */
  totalPaise: number;
  sacCode: string;
  /** Why a manual line was added, and who approved it when a manager had to. */
  reason: string | null;
  approvedBy: string | null;
  /** True for a line added by hand, which can be removed while the bill is open. */
  manual: boolean;
  /** Set when a credit note has reversed this line. */
  creditNoteNumber: string | null;
  postedAt: string;
}

export interface BillTotalsDto {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  subtotalPaise: number;
  /** What rounding the total to a whole rupee added or took off. */
  roundOffPaise: number;
  totalPaise: number;
}

export interface PaymentDto {
  id: string;
  billId: string;
  bookingId: string;
  bookingCode: string;
  guestName: string;
  kind: PaymentKind;
  method: PaymentMethod;
  amountPaise: number;
  reference: string;
  /** Why a refund was made. */
  reason: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface CreditNoteDto {
  id: string;
  /** Gap-free per financial year, like `CN/2026-27/000001`. */
  number: string;
  invoiceNumber: string;
  lineId: string;
  description: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  reason: string;
  issuedBy: string;
  issuedAt: string;
}

/** The legal details printed on an issued invoice. They are copies and never change. */
export interface InvoiceDto {
  /** Gap-free per financial year, like `INV/2026-27/000001`. */
  number: string;
  financialYear: string;
  issuedAt: string;
  supplier: {
    legalName: string;
    gstin: string | null;
    stateName: string;
    address: string;
  };
  /** The state the supply is treated as made in. Decides CGST + SGST or IGST. */
  placeOfSupplyState: string;
  intraState: boolean;
  totals: BillTotalsDto;
}

export interface BillDto {
  id: string;
  bookingId: string;
  bookingCode: string;
  guest: { name: string; phone: string; gstin: string | null };
  roomNumber: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  status: BillStatus;
  lines: BillLineDto[];
  /** Live for an open bill; the issued figures for a finalized one. */
  totals: BillTotalsDto;
  paidPaise: number;
  refundedPaise: number;
  creditNotePaise: number;
  /** What the guest still owes. Negative when they are owed money back. */
  balancePaise: number;
  payments: PaymentDto[];
  creditNotes: CreditNoteDto[];
  invoice: InvoiceDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillSummaryDto {
  id: string;
  bookingId: string;
  bookingCode: string;
  guestName: string;
  roomNumber: string;
  status: BillStatus;
  invoiceNumber: string | null;
  totalPaise: number;
  balancePaise: number;
  createdAt: string;
}

export interface PaymentsSummaryDto {
  date: string;
  /** Money in minus money out, by method. */
  netByMethod: Record<string, number>;
  collectedPaise: number;
  refundedPaise: number;
  netPaise: number;
  count: number;
}

export interface CheckOutResultDto {
  bookingId: string;
  bookingCode: string;
  roomNumber: string;
  status: 'checked_out';
  checkedOutAt: string;
  bill: BillDto;
}
