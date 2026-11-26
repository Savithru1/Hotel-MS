import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export interface RoomNightDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  roomId: Types.ObjectId;
  /** The date the night starts, `YYYY-MM-DD` in the property's timezone. */
  night: string;
  bookingId: Types.ObjectId;
}

/**
 * One document per room per night that is taken. The unique index below is what makes double
 * booking impossible: two bookings that both want a night try to insert the same key, and the
 * database lets exactly one of them through, however many requests arrive at once.
 */
const roomNightSchema = new Schema<RoomNightDocument>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    night: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
  },
  { versionKey: false },
);

roomNightSchema.plugin(tenantPlugin);
roomNightSchema.index({ propertyId: 1, roomId: 1, night: 1 }, { unique: true });
roomNightSchema.index({ propertyId: 1, bookingId: 1 });
roomNightSchema.index({ propertyId: 1, night: 1 });

export const RoomNight =
  (mongoose.models.RoomNight as mongoose.Model<RoomNightDocument> | undefined) ??
  mongoose.model<RoomNightDocument>('RoomNight', roomNightSchema, 'room_nights');
