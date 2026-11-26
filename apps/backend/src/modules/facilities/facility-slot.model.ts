import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export interface FacilitySlotDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  facilityId: Types.ObjectId;
  /** The exact start of the slot (UTC). */
  slotStart: Date;
  /** How many people are booked into the slot right now. */
  booked: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One counter per slot that has ever been booked. A booking adds its people with a single
 * conditional update (`booked <= capacity - people`), so two bookings racing for the last place
 * can never both get it, and a cancellation gives the places back. It is what makes a full slot
 * impossible to book again.
 */
const facilitySlotSchema = new Schema<FacilitySlotDocument>(
  {
    facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', required: true },
    slotStart: { type: Date, required: true },
    booked: { type: Number, required: true, min: 0, validate: Number.isInteger },
  },
  { timestamps: true },
);

facilitySlotSchema.plugin(tenantPlugin);
facilitySlotSchema.index({ propertyId: 1, facilityId: 1, slotStart: 1 }, { unique: true });

export const FacilitySlot =
  (mongoose.models.FacilitySlot as mongoose.Model<FacilitySlotDocument> | undefined) ??
  mongoose.model<FacilitySlotDocument>('FacilitySlot', facilitySlotSchema, 'facility_slots');
