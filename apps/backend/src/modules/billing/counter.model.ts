import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export interface CounterDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  /** Which sequence this is, like `invoice:2026-27`. */
  key: string;
  seq: number;
}

/**
 * Gap-free sequences. A number is taken by one atomic increment inside the same transaction that
 * uses it, so a transaction that fails gives the number back and no number is ever skipped.
 */
const counterSchema = new Schema<CounterDocument>({
  key: { type: String, required: true },
  seq: { type: Number, required: true, default: 0, min: 0 },
});

counterSchema.plugin(tenantPlugin);
counterSchema.index({ propertyId: 1, key: 1 }, { unique: true });

export const Counter =
  (mongoose.models.Counter as mongoose.Model<CounterDocument> | undefined) ??
  mongoose.model<CounterDocument>('Counter', counterSchema, 'counters');
