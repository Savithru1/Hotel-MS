import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export interface CreditNoteDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  billId: Types.ObjectId;
  bookingId: Types.ObjectId;
  /** The invoice this note corrects. */
  invoiceNumber: string;
  /** Gap-free per financial year, like `CN/2026-27/000001`. */
  number: string;
  /** The bill line it reverses. */
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
  issuedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const whole = { validator: Number.isInteger, message: 'must be a whole number of paise' };

/**
 * An invoice is never edited once issued. A mistake is corrected by a credit note that reverses
 * one line, with its own number. A line can be reversed once.
 */
const creditNoteSchema = new Schema<CreditNoteDocument>(
  {
    billId: { type: Schema.Types.ObjectId, ref: 'Bill', required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    invoiceNumber: { type: String, required: true },
    number: { type: String, required: true },
    lineId: { type: String, required: true },
    description: { type: String, required: true },
    taxablePaise: { type: Number, required: true, validate: whole },
    cgstPaise: { type: Number, required: true, validate: whole },
    sgstPaise: { type: Number, required: true, validate: whole },
    igstPaise: { type: Number, required: true, validate: whole },
    taxPaise: { type: Number, required: true, validate: whole },
    totalPaise: { type: Number, required: true, validate: whole },
    reason: { type: String, required: true, maxlength: 200 },
    issuedBy: { type: String, required: true },
    issuedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

creditNoteSchema.plugin(tenantPlugin);
creditNoteSchema.index({ propertyId: 1, number: 1 }, { unique: true });
creditNoteSchema.index({ propertyId: 1, billId: 1, lineId: 1 }, { unique: true });

export const CreditNote =
  (mongoose.models.CreditNote as mongoose.Model<CreditNoteDocument> | undefined) ??
  mongoose.model<CreditNoteDocument>('CreditNote', creditNoteSchema, 'credit_notes');
