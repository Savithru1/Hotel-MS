import {
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  type PaymentKind,
  type PaymentMethod,
} from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export interface PaymentDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  billId: Types.ObjectId;
  bookingId: Types.ObjectId;
  bookingCode: string;
  guestName: string;
  kind: PaymentKind;
  method: PaymentMethod;
  /** Always positive. A refund is a row of kind `refund`, never a negative payment. */
  amountPaise: number;
  reference: string;
  /** Why a refund was made. */
  reason: string | null;
  /** `manual` for money taken by staff; an online gateway name once P1.13 exists. */
  provider: string;
  /** The gateway's payment id for an online payment, unique so a repeat is never recorded twice. */
  providerPaymentId: string | null;
  recordedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The payments ledger: every payment and refund, one row each, never edited or deleted. */
const paymentSchema = new Schema<PaymentDocument>(
  {
    billId: { type: Schema.Types.ObjectId, ref: 'Bill', required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    bookingCode: { type: String, required: true },
    guestName: { type: String, required: true },
    kind: { type: String, enum: [...PAYMENT_KINDS], required: true },
    method: { type: String, enum: [...PAYMENT_METHODS], required: true },
    amountPaise: { type: Number, required: true, min: 1, validate: Number.isInteger },
    reference: { type: String, default: '', maxlength: 60 },
    reason: { type: String, default: null },
    provider: { type: String, default: 'manual' },
    providerPaymentId: { type: String, default: null },
    recordedBy: { type: String, required: true },
  },
  { timestamps: true },
);

paymentSchema.plugin(tenantPlugin);
paymentSchema.index({ propertyId: 1, billId: 1, createdAt: 1 });
paymentSchema.index({ propertyId: 1, createdAt: -1 });
paymentSchema.index(
  { propertyId: 1, provider: 1, providerPaymentId: 1 },
  { unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string' } } },
);

export const Payment =
  (mongoose.models.Payment as mongoose.Model<PaymentDocument> | undefined) ??
  mongoose.model<PaymentDocument>('Payment', paymentSchema, 'payments');
