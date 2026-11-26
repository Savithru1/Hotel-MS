import { GUEST_ID_TYPES, type GuestIdType } from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export interface GuestDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  name: string;
  /** E.164, for example `+919876543210`. The one stored form, so matching is exact. */
  phone: string;
  /** Empty in Phase 1. Set when phone + OTP verification exists. */
  phoneVerifiedAt: Date | null;
  email: string | null;
  gstin: string | null;
  /** Sensitive. Never returned by normal reads; `select: false` keeps it out of queries. */
  idDetails?: { idType: GuestIdType; idNumber: string } | undefined;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Guest profiles created by the front desk. They have no password in Phase 1. The collection is
 * `users`, as in the plan; staff accounts live in `staff`.
 */
const guestSchema = new Schema<GuestDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, required: true, match: /^\+[1-9][0-9]{6,14}$/ },
    phoneVerifiedAt: { type: Date, default: null },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
    gstin: { type: String, trim: true, uppercase: true, default: null },
    idDetails: {
      type: new Schema(
        {
          idType: { type: String, enum: [...GUEST_ID_TYPES], required: true },
          idNumber: { type: String, required: true, trim: true, maxlength: 30 },
        },
        { _id: false },
      ),
      select: false,
    },
  },
  { timestamps: true },
);

guestSchema.plugin(tenantPlugin);
guestSchema.index({ propertyId: 1, phone: 1 }, { unique: true });
guestSchema.index({ propertyId: 1, name: 1 });

export const Guest =
  (mongoose.models.Guest as mongoose.Model<GuestDocument> | undefined) ??
  mongoose.model<GuestDocument>('Guest', guestSchema, 'users');
