import { DEPARTMENTS, STAFF_ROLES, type Department, type StaffRole } from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export interface StaffDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  name: string;
  email: string;
  passwordHash: string;
  role: StaffRole;
  departments: Department[];
  active: boolean;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const staffSchema = new Schema<StaffDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    // `select: false` keeps the hash out of every query unless it is asked for by name.
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: [...STAFF_ROLES], required: true },
    departments: { type: [{ type: String, enum: [...DEPARTMENTS] }], default: [] },
    active: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

staffSchema.plugin(tenantPlugin);
staffSchema.index({ propertyId: 1, email: 1 }, { unique: true });
staffSchema.index({ propertyId: 1, role: 1, active: 1 });

export const Staff =
  (mongoose.models.Staff as mongoose.Model<StaffDocument> | undefined) ??
  mongoose.model<StaffDocument>('Staff', staffSchema, 'staff');
