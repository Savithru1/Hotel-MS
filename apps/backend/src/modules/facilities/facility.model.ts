import {
  FACILITY_TYPES,
  MAX_FACILITY_CAPACITY,
  MAX_FACILITY_PRICE_PAISE,
  type FacilityType,
} from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export interface FacilityDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  name: string;
  /** The name in lower case. Unique per property, so "Spa" and "spa" clash. */
  nameKey: string;
  type: FacilityType;
  description: string;
  /** How many people one slot takes. 1 means one booking at a time. */
  capacity: number;
  slotMinutes: number;
  /** `HH:mm` in the property's timezone. */
  opensAt: string;
  closesAt: string;
  /** Per person, per slot, in paise, before tax. */
  pricePaise: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Spa, pool, gym and activities: anything a guest can book by the slot. */
const facilitySchema = new Schema<FacilityDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    nameKey: { type: String, required: true, lowercase: true, trim: true },
    type: { type: String, enum: [...FACILITY_TYPES], required: true },
    description: { type: String, default: '', trim: true, maxlength: 300 },
    capacity: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_FACILITY_CAPACITY,
      validate: Number.isInteger,
    },
    slotMinutes: { type: Number, required: true, min: 5, validate: Number.isInteger },
    opensAt: { type: String, required: true, match: TIME_OF_DAY },
    closesAt: { type: String, required: true, match: TIME_OF_DAY },
    pricePaise: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_FACILITY_PRICE_PAISE,
      validate: Number.isInteger,
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

facilitySchema.plugin(tenantPlugin);
facilitySchema.index({ propertyId: 1, nameKey: 1 }, { unique: true });
facilitySchema.index({ propertyId: 1, type: 1, nameKey: 1 });
facilitySchema.index({ propertyId: 1, active: 1 });

export const Facility =
  (mongoose.models.Facility as mongoose.Model<FacilityDocument> | undefined) ??
  mongoose.model<FacilityDocument>('Facility', facilitySchema, 'facilities');
