import type { MenuImageType } from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../../shared/tenant-plugin';

export interface MenuOptionChoiceDocument {
  label: string;
  pricePaise: number;
}

export interface MenuOptionGroupDocument {
  name: string;
  required: boolean;
  multiple: boolean;
  choices: MenuOptionChoiceDocument[];
}

export interface MenuItemDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  name: string;
  /** The name in lower case. Unique per property, so "Masala Chai" and "masala chai" clash. */
  nameKey: string;
  category: string;
  description: string;
  /** Price per portion in paise, before tax. */
  pricePaise: number;
  options: MenuOptionGroupDocument[];
  available: boolean;
  /** The image in GridFS, when there is one. */
  imageId: Types.ObjectId | null;
  imageType: MenuImageType | null;
  createdAt: Date;
  updatedAt: Date;
}

const wholePaise = {
  validator: Number.isInteger,
  message: 'must be a whole number of paise',
};

const choiceSchema = new Schema<MenuOptionChoiceDocument>(
  {
    label: { type: String, required: true, trim: true, maxlength: 40 },
    pricePaise: { type: Number, required: true, min: 0, validate: wholePaise },
  },
  { _id: false },
);

const groupSchema = new Schema<MenuOptionGroupDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    required: { type: Boolean, default: false },
    multiple: { type: Boolean, default: false },
    choices: { type: [choiceSchema], default: [] },
  },
  { _id: false },
);

/** The menu of one property: the dishes and drinks the kitchen can be asked for. */
const menuItemSchema = new Schema<MenuItemDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    nameKey: { type: String, required: true, lowercase: true, trim: true },
    category: { type: String, required: true, trim: true, maxlength: 40 },
    description: { type: String, default: '', trim: true, maxlength: 300 },
    pricePaise: { type: Number, required: true, min: 1, validate: wholePaise },
    options: { type: [groupSchema], default: [] },
    available: { type: Boolean, default: true },
    imageId: { type: Schema.Types.ObjectId, default: null },
    imageType: { type: String, default: null },
  },
  { timestamps: true },
);

menuItemSchema.plugin(tenantPlugin);
menuItemSchema.index({ propertyId: 1, nameKey: 1 }, { unique: true });
menuItemSchema.index({ propertyId: 1, category: 1, nameKey: 1 });
menuItemSchema.index({ propertyId: 1, available: 1 });

export const MenuItem =
  (mongoose.models.MenuItem as mongoose.Model<MenuItemDocument> | undefined) ??
  mongoose.model<MenuItemDocument>('MenuItem', menuItemSchema, 'food_menus');
