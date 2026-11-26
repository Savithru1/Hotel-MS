import {
  FOOD_ORDER_STATUSES,
  FOOD_ORDER_TRANSITIONS,
  type FoodOrderStatus,
} from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { defineStateMachine, stateFields, type HistoryEntry } from '../../shared/state-machine';
import { tenantPlugin } from '../../shared/tenant-plugin';

/** Received -> Preparing -> Ready -> Delivered. Cancelled only while still Received. */
export const foodOrderMachine = defineStateMachine<FoodOrderStatus>({
  name: 'food order',
  initial: 'received',
  transitions: Object.fromEntries(
    FOOD_ORDER_STATUSES.map((status) => [status, FOOD_ORDER_TRANSITIONS[status]]),
  ) as Record<FoodOrderStatus, readonly FoodOrderStatus[]>,
});

export interface FoodOrderOptionDocument {
  group: string;
  label: string;
  pricePaise: number;
}

/** A line as it was when the order was placed. Later menu edits never reach back into it. */
export interface FoodOrderLineDocument {
  menuItemId: Types.ObjectId;
  name: string;
  quantity: number;
  unitPricePaise: number;
  options: FoodOrderOptionDocument[];
  note: string;
  lineTotalPaise: number;
}

export interface FoodOrderDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  code: string;
  roomId: Types.ObjectId;
  /** Copied at order time so the kitchen ticket never depends on later room or guest edits. */
  roomNumber: string;
  bookingId: Types.ObjectId;
  guestName: string;
  items: FoodOrderLineDocument[];
  notes: string;
  /** Sum of the lines in paise, before tax. Billing adds tax when it posts the order (P1.10). */
  subtotalPaise: number;
  status: FoodOrderStatus;
  history: HistoryEntry[];
  source: 'front_desk' | 'kitchen' | 'guest';
  createdBy: string | null;
  cancelReason: string | null;
  preparingAt: Date | null;
  readyAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const wholeNumber = { validator: Number.isInteger, message: 'must be a whole number' };

const optionSchema = new Schema<FoodOrderOptionDocument>(
  {
    group: { type: String, required: true },
    label: { type: String, required: true },
    pricePaise: { type: Number, required: true, min: 0, validate: wholeNumber },
  },
  { _id: false },
);

const lineSchema = new Schema<FoodOrderLineDocument>(
  {
    menuItemId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1, validate: wholeNumber },
    unitPricePaise: { type: Number, required: true, min: 0, validate: wholeNumber },
    options: { type: [optionSchema], default: [] },
    note: { type: String, default: '' },
    lineTotalPaise: { type: Number, required: true, min: 0, validate: wholeNumber },
  },
  { _id: false },
);

const foodOrderSchema = new Schema<FoodOrderDocument>(
  {
    code: { type: String, required: true },
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    roomNumber: { type: String, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
    guestName: { type: String, required: true },
    items: {
      type: [lineSchema],
      validate: { validator: (lines: unknown[]) => lines.length > 0, message: 'is empty' },
    },
    notes: { type: String, default: '', maxlength: 300 },
    subtotalPaise: { type: Number, required: true, min: 0, validate: wholeNumber },
    ...stateFields(foodOrderMachine),
    source: { type: String, enum: ['front_desk', 'kitchen', 'guest'], default: 'front_desk' },
    createdBy: { type: String, default: null },
    cancelReason: { type: String, default: null },
    preparingAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

foodOrderSchema.plugin(tenantPlugin);
foodOrderSchema.index({ propertyId: 1, code: 1 }, { unique: true });
foodOrderSchema.index({ propertyId: 1, status: 1, createdAt: 1 });
foodOrderSchema.index({ propertyId: 1, status: 1, deliveredAt: -1 });
foodOrderSchema.index({ propertyId: 1, bookingId: 1, createdAt: 1 });
foodOrderSchema.index({ propertyId: 1, roomId: 1, status: 1 });

export const FoodOrder =
  (mongoose.models.FoodOrder as mongoose.Model<FoodOrderDocument> | undefined) ??
  mongoose.model<FoodOrderDocument>('FoodOrder', foodOrderSchema, 'food_orders');
