import {
  BILL_LINE_KINDS,
  BILL_STATUSES,
  GST_CATEGORIES,
  type BillLineKind,
  type BillStatus,
  type GstCategory,
} from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';
import type { BillTotals } from './gst';

/** One line of a bill. Every tax figure is a copy taken when the line was posted. */
export interface BillLineDocument {
  lineId: string;
  kind: BillLineKind;
  /**
   * What the line is for, like `room:2026-11-26` or `food:<order id>`. Unique within a bill, which
   * is what makes posting idempotent: the same night or order can never be posted twice.
   */
  sourceKey: string;
  category: GstCategory;
  description: string;
  serviceDate: string;
  quantity: number;
  unitPaise: number;
  taxablePaise: number;
  ratePercent: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  sacCode: string;
  ruleEffectiveFrom: string;
  reason: string | null;
  addedBy: string | null;
  approvedBy: string | null;
  postedAt: Date;
}

/** What is printed on the invoice. Written once, when the bill is finalized, and never edited. */
export interface BillInvoiceDocument {
  number: string;
  financialYear: string;
  issuedAt: Date;
  supplier: { legalName: string; gstin: string | null; stateName: string; address: string };
  placeOfSupplyState: string;
  intraState: boolean;
  totals: BillTotals;
}

export interface BillDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  bookingId: Types.ObjectId;
  bookingCode: string;
  guestName: string;
  guestPhone: string;
  guestGstin: string | null;
  /** The guest's state from their GSTIN, or null for a guest without one. */
  placeOfSupplyState: string | null;
  /** CGST + SGST (true) or IGST (false). Decided when the bill is created. */
  intraState: boolean;
  roomNumber: string;
  nightlyRatePaise: number;
  checkInDate: string;
  checkOutDate: string;
  status: BillStatus;
  lines: BillLineDocument[];
  invoice: BillInvoiceDocument | null;
  /**
   * Bumped by every change that touches money. Two such changes at the same moment collide on this
   * field, so they run one after the other and each sees the other's result.
   */
  rev: number;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const whole = { validator: Number.isInteger, message: 'must be a whole number of paise' };

const lineSchema = new Schema<BillLineDocument>(
  {
    lineId: { type: String, required: true },
    kind: { type: String, enum: [...BILL_LINE_KINDS], required: true },
    sourceKey: { type: String, required: true },
    category: { type: String, enum: [...GST_CATEGORIES], required: true },
    description: { type: String, required: true, maxlength: 200 },
    serviceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    quantity: { type: Number, required: true, min: 1, validate: whole },
    unitPaise: { type: Number, required: true, validate: whole },
    taxablePaise: { type: Number, required: true, validate: whole },
    ratePercent: { type: Number, required: true, min: 0 },
    cgstPaise: { type: Number, required: true, validate: whole },
    sgstPaise: { type: Number, required: true, validate: whole },
    igstPaise: { type: Number, required: true, validate: whole },
    taxPaise: { type: Number, required: true, validate: whole },
    totalPaise: { type: Number, required: true, validate: whole },
    sacCode: { type: String, required: true },
    ruleEffectiveFrom: { type: String, required: true },
    reason: { type: String, default: null },
    addedBy: { type: String, default: null },
    approvedBy: { type: String, default: null },
    postedAt: { type: Date, required: true },
  },
  { _id: false },
);

const totalsSchema = new Schema(
  {
    taxablePaise: { type: Number, required: true },
    cgstPaise: { type: Number, required: true },
    sgstPaise: { type: Number, required: true },
    igstPaise: { type: Number, required: true },
    taxPaise: { type: Number, required: true },
    subtotalPaise: { type: Number, required: true },
    roundOffPaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    number: { type: String, required: true },
    financialYear: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    supplier: {
      legalName: { type: String, default: '' },
      gstin: { type: String, default: null },
      stateName: { type: String, default: '' },
      address: { type: String, default: '' },
    },
    placeOfSupplyState: { type: String, default: '' },
    intraState: { type: Boolean, required: true },
    totals: { type: totalsSchema, required: true },
  },
  { _id: false },
);

/** The folio of one booking: every charge, as it was taxed, until it is turned into an invoice. */
const billSchema = new Schema<BillDocument>(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    bookingCode: { type: String, required: true },
    guestName: { type: String, required: true },
    guestPhone: { type: String, required: true },
    guestGstin: { type: String, default: null },
    placeOfSupplyState: { type: String, default: null },
    intraState: { type: Boolean, required: true },
    roomNumber: { type: String, required: true },
    nightlyRatePaise: { type: Number, required: true, min: 0, validate: whole },
    checkInDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    checkOutDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: [...BILL_STATUSES], default: 'open' },
    lines: { type: [lineSchema], default: [] },
    invoice: { type: invoiceSchema, default: null },
    rev: { type: Number, default: 0 },
    finalizedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

billSchema.plugin(tenantPlugin);
billSchema.index({ propertyId: 1, bookingId: 1 }, { unique: true });
billSchema.index({ propertyId: 1, status: 1, createdAt: -1 });
// Invoice numbers are unique per property, and only bills that have an invoice carry one.
billSchema.index(
  { propertyId: 1, 'invoice.number': 1 },
  { unique: true, partialFilterExpression: { 'invoice.number': { $type: 'string' } } },
);

export const Bill =
  (mongoose.models.Bill as mongoose.Model<BillDocument> | undefined) ??
  mongoose.model<BillDocument>('Bill', billSchema, 'bills');
