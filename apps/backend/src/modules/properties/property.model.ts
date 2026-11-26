import { DEPARTMENTS, type Department } from '@hospitality/constants';
import type { GstRuleSet, PropertyAddress } from '@hospitality/shared-types';
import mongoose, { Schema, type Types } from 'mongoose';
import { DEFAULT_GST_EFFECTIVE_FROM, defaultGstRuleSet } from './gst-defaults';

export interface PropertyDocument {
  _id: Types.ObjectId;
  name: string;
  /** The stable link name used on the login page and in guest links, for example `grand-plaza`. */
  slug: string;
  active: boolean;
  legalName: string;
  address: PropertyAddress;
  stateName: string;
  gstin: string | null;
  timezone: string;
  checkInTime: string;
  checkOutTime: string;
  currency: 'INR';
  departments: Department[];
  gstRules: GstRuleSet[];
  createdAt: Date;
  updatedAt: Date;
}

const gstSlabSchema = new Schema(
  { upToPaise: { type: Number, default: null }, ratePercent: { type: Number, required: true } },
  { _id: false },
);

const gstRuleSetSchema = new Schema(
  {
    effectiveFrom: { type: String, required: true },
    room: { slabs: { type: [gstSlabSchema], required: true } },
    food: {
      ratePercent: { type: Number, required: true },
      highTariffThresholdPaise: { type: Number, required: true },
      highTariffRatePercent: { type: Number, required: true },
    },
    spaRecreation: { ratePercent: { type: Number, required: true } },
    other: { ratePercent: { type: Number, required: true } },
  },
  { _id: false },
);

/**
 * A property (hotel) is the tenant itself, so it does not carry a `propertyId` and does not use
 * the tenant plugin. It is only ever read by id from a verified token or by slug at sign-in, and
 * it is on the allow-list in `tenant-models.test.ts`.
 */
const propertySchema = new Schema<PropertyDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 60,
      match: /^[a-z0-9]+(-[a-z0-9]+)*$/,
      unique: true,
    },
    active: { type: Boolean, default: true },
    legalName: { type: String, trim: true, maxlength: 160, default: '' },
    address: {
      line1: { type: String, trim: true, default: '' },
      line2: { type: String, trim: true, default: '' },
      city: { type: String, trim: true, default: '' },
      state: { type: String, trim: true, default: '' },
      pincode: { type: String, trim: true, default: '' },
    },
    stateName: { type: String, trim: true, default: '' },
    gstin: { type: String, trim: true, default: null },
    timezone: { type: String, default: 'Asia/Kolkata' },
    checkInTime: { type: String, default: '14:00' },
    checkOutTime: { type: String, default: '11:00' },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    departments: {
      type: [{ type: String, enum: [...DEPARTMENTS] }],
      default: () => [...DEPARTMENTS],
    },
    gstRules: {
      type: [gstRuleSetSchema],
      default: () => [defaultGstRuleSet(DEFAULT_GST_EFFECTIVE_FROM)],
    },
  },
  { timestamps: true },
);

export const Property =
  (mongoose.models.Property as mongoose.Model<PropertyDocument> | undefined) ??
  mongoose.model<PropertyDocument>('Property', propertySchema, 'properties');
