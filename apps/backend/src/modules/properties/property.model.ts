import mongoose, { Schema, type Types } from 'mongoose';

export interface PropertyDocument {
  _id: Types.ObjectId;
  name: string;
  /** The stable link name used on the login page and in guest links, for example `grand-plaza`. */
  slug: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

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
  },
  { timestamps: true },
);

export const Property =
  (mongoose.models.Property as mongoose.Model<PropertyDocument> | undefined) ??
  mongoose.model<PropertyDocument>('Property', propertySchema, 'properties');
