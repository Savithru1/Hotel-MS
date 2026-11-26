import {
  FACILITY_BOOKING_STATUSES,
  FACILITY_BOOKING_TRANSITIONS,
  FACILITY_TYPES,
  type FacilityBookingStatus,
  type FacilityType,
} from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { defineStateMachine, stateFields, type HistoryEntry } from '../../shared/state-machine';
import { tenantPlugin } from '../../shared/tenant-plugin';

/** Requested -> Confirmed -> Active -> Completed. Cancelled before it starts, No-show once confirmed. */
export const facilityBookingMachine = defineStateMachine<FacilityBookingStatus>({
  name: 'facility booking',
  initial: 'requested',
  transitions: Object.fromEntries(
    FACILITY_BOOKING_STATUSES.map((status) => [status, FACILITY_BOOKING_TRANSITIONS[status]]),
  ) as Record<FacilityBookingStatus, readonly FacilityBookingStatus[]>,
});

export interface FacilityBookingDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  code: string;
  facilityId: Types.ObjectId;
  /** Copied at booking time so the booking never depends on later facility edits. */
  facilityName: string;
  facilityType: FacilityType;
  roomId: Types.ObjectId;
  roomNumber: string;
  bookingId: Types.ObjectId;
  guestName: string;
  /** `YYYY-MM-DD` in the property's timezone. */
  date: string;
  startTime: string;
  endTime: string;
  /** The exact start and end of the slot (UTC). */
  slotStart: Date;
  slotEnd: Date;
  participants: number;
  /** Price per person, copied when the booking was made, in paise before tax. */
  unitPricePaise: number;
  totalPaise: number;
  notes: string;
  status: FacilityBookingStatus;
  history: HistoryEntry[];
  source: 'front_desk' | 'spa_recreation' | 'guest';
  createdBy: string | null;
  cancelReason: string | null;
  confirmedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const wholeNumber = { validator: Number.isInteger, message: 'must be a whole number' };
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

const facilityBookingSchema = new Schema<FacilityBookingDocument>(
  {
    code: { type: String, required: true },
    facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', required: true },
    facilityName: { type: String, required: true },
    facilityType: { type: String, enum: [...FACILITY_TYPES], required: true },
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    roomNumber: { type: String, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    guestName: { type: String, required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    startTime: { type: String, required: true, match: TIME_OF_DAY },
    endTime: { type: String, required: true, match: TIME_OF_DAY },
    slotStart: { type: Date, required: true },
    slotEnd: { type: Date, required: true },
    participants: { type: Number, required: true, min: 1, validate: wholeNumber },
    unitPricePaise: { type: Number, required: true, min: 0, validate: wholeNumber },
    totalPaise: { type: Number, required: true, min: 0, validate: wholeNumber },
    notes: { type: String, default: '', maxlength: 300 },
    ...stateFields(facilityBookingMachine),
    source: {
      type: String,
      enum: ['front_desk', 'spa_recreation', 'guest'],
      default: 'front_desk',
    },
    createdBy: { type: String, default: null },
    cancelReason: { type: String, default: null },
    confirmedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

facilityBookingSchema.plugin(tenantPlugin);
facilityBookingSchema.index({ propertyId: 1, code: 1 }, { unique: true });
facilityBookingSchema.index({ propertyId: 1, date: 1, slotStart: 1 });
facilityBookingSchema.index({ propertyId: 1, facilityId: 1, slotStart: 1, status: 1 });
facilityBookingSchema.index({ propertyId: 1, bookingId: 1, status: 1 });
facilityBookingSchema.index({ propertyId: 1, status: 1, slotStart: 1 });

export const FacilityBooking =
  (mongoose.models.FacilityBooking as mongoose.Model<FacilityBookingDocument> | undefined) ??
  mongoose.model<FacilityBookingDocument>(
    'FacilityBooking',
    facilityBookingSchema,
    'facility_bookings',
  );
