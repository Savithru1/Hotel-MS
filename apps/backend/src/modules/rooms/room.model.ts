import type { RoomStatus } from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { stateFields, type HistoryEntry } from '../../shared/state-machine';
import { tenantPlugin } from '../../shared/tenant-plugin';
import { roomStatusMachine } from './room-status';

export interface RoomDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  /** A label such as `204` or `B-12`, kept exactly as typed. */
  number: string;
  floor: number;
  roomTypeId: Types.ObjectId;
  status: RoomStatus;
  history: HistoryEntry[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const roomSchema = new Schema<RoomDocument>(
  {
    number: { type: String, required: true, trim: true, maxlength: 10 },
    floor: { type: Number, required: true, min: -5, max: 200, validate: Number.isInteger },
    roomTypeId: { type: Schema.Types.ObjectId, ref: 'RoomType', required: true },
    ...stateFields(roomStatusMachine),
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

roomSchema.plugin(tenantPlugin);
roomSchema.index(
  { propertyId: 1, number: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } },
);
roomSchema.index({ propertyId: 1, floor: 1, number: 1 });
roomSchema.index({ propertyId: 1, status: 1 });

export const Room =
  (mongoose.models.Room as mongoose.Model<RoomDocument> | undefined) ??
  mongoose.model<RoomDocument>('Room', roomSchema, 'rooms');
