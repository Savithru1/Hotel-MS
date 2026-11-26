import type { FoodOrderStatus } from '@hospitality/constants';

export interface MenuOptionChoiceDto {
  label: string;
  /** Extra charge for this choice, in paise. Zero when free. */
  pricePaise: number;
}

export interface MenuOptionGroupDto {
  name: string;
  required: boolean;
  /** More than one choice may be picked. */
  multiple: boolean;
  choices: MenuOptionChoiceDto[];
}

export interface MenuItemDto {
  id: string;
  name: string;
  category: string;
  description: string;
  /** Price per portion in paise, before tax. Tax is added by billing. */
  pricePaise: number;
  options: MenuOptionGroupDto[];
  available: boolean;
  hasImage: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An option exactly as it was priced when the order was placed. */
export interface FoodOrderOptionDto {
  group: string;
  label: string;
  pricePaise: number;
}

/** A line of an order. Name and prices are copies taken at order time and never change. */
export interface FoodOrderLineDto {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPricePaise: number;
  options: FoodOrderOptionDto[];
  note: string;
  lineTotalPaise: number;
}

export interface FoodOrderDto {
  id: string;
  /** Short readable code such as `FO-7H3K9Q`, for the kitchen to call out. */
  code: string;
  roomId: string;
  roomNumber: string;
  bookingId: string;
  guestName: string;
  items: FoodOrderLineDto[];
  notes: string;
  /** Sum of the lines in paise, before tax. */
  subtotalPaise: number;
  status: FoodOrderStatus;
  cancelReason: string | null;
  source: 'front_desk' | 'kitchen' | 'guest';
  createdAt: string;
  updatedAt: string;
  preparingAt: string | null;
  readyAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
}

export interface FoodOrderSummaryDto {
  byStatus: Record<string, number>;
  /** Open orders older than the late limit. */
  late: number;
}
