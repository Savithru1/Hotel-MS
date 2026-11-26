import { BOOKING_STATUSES, type BookingStatus } from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { stateFields, type HistoryEntry } from '../../shared/state-machine';
import { tenantPlugin } from '../../shared/tenant-plugin';
import { bookingStatusMachine } from './booking-status';

export interface BookingDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  bookingCode: string;
  guestId: Types.ObjectId;
  /** The guest's details as they were when the booking was made. */
  guestSnapshot: { name: string; phone: string; email: string | null };
  roomTypeId: Types.ObjectId;
  roomId: Types.ObjectId;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  adults: number;
  children: number;
  nightlyRatePaise: number;
  notes: string;
  source: 'front_desk';
  status: BookingStatus;
  history: HistoryEntry[];
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const bookingSchema = new Schema<BookingDocument>(
  {
    bookingCode: { type: String, required: true },
    guestId: { type: Schema.Types.ObjectId, ref: 'Guest', required: true },
    guestSnapshot: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String, default: null },
    },
    roomTypeId: { type: Schema.Types.ObjectId, ref: 'RoomType', required: true },
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    checkInDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    checkOutDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    nights: { type: Number, required: true, min: 1, validate: Number.isInteger },
    adults: { type: Number, required: true, min: 1, validate: Number.isInteger },
    children: { type: Number, default: 0, min: 0, validate: Number.isInteger },
    nightlyRatePaise: { type: Number, required: true, min: 0, validate: Number.isInteger },
    notes: { type: String, default: '', maxlength: 500 },
    source: { type: String, enum: ['front_desk'], default: 'front_desk' },
    ...stateFields(bookingStatusMachine),
    checkedInAt: { type: Date, default: null },
    checkedOutAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
  },
  { timestamps: true },
);

bookingSchema.plugin(tenantPlugin);
bookingSchema
  .path('status')
  .validate((value: string) => BOOKING_STATUSES.includes(value as BookingStatus));
bookingSchema.index({ propertyId: 1, bookingCode: 1 }, { unique: true });
bookingSchema.index({ propertyId: 1, status: 1, checkInDate: 1 });
bookingSchema.index({ propertyId: 1, status: 1, checkOutDate: 1 });
bookingSchema.index({ propertyId: 1, roomId: 1, checkInDate: 1 });
bookingSchema.index({ propertyId: 1, guestId: 1 });

export const Booking =
  (mongoose.models.Booking as mongoose.Model<BookingDocument> | undefined) ??
  mongoose.model<BookingDocument>('Booking', bookingSchema, 'bookings');
