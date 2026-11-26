import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export interface RoomTypeDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  name: string;
  capacity: number;
  /** Nightly tariff in whole paise. */
  ratePaise: number;
  amenities: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const roomTypeSchema = new Schema<RoomTypeDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    capacity: { type: Number, required: true, min: 1, max: 20, validate: Number.isInteger },
    ratePaise: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: 'must be a whole number of paise' },
    },
    amenities: { type: [String], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

roomTypeSchema.plugin(tenantPlugin);
// Names are unique within a property, ignoring letter case ("Deluxe" and "deluxe" are one type).
roomTypeSchema.index(
  { propertyId: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
);

export const RoomType =
  (mongoose.models.RoomType as mongoose.Model<RoomTypeDocument> | undefined) ??
  mongoose.model<RoomTypeDocument>('RoomType', roomTypeSchema, 'room_types');
