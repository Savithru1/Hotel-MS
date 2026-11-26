import type { FoodOrderDto } from '@hospitality/shared-types';
import type { FoodOrderDocument } from './food-order.model';

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toFoodOrderDto(order: FoodOrderDocument): FoodOrderDto {
  return {
    id: order._id.toHexString(),
    code: order.code,
    roomId: order.roomId.toHexString(),
    roomNumber: order.roomNumber,
    bookingId: order.bookingId.toHexString(),
    guestName: order.guestName,
    items: order.items.map((line) => ({
      menuItemId: line.menuItemId.toHexString(),
      name: line.name,
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      options: line.options.map((option) => ({
        group: option.group,
        label: option.label,
        pricePaise: option.pricePaise,
      })),
      note: line.note,
      lineTotalPaise: line.lineTotalPaise,
    })),
    notes: order.notes,
    subtotalPaise: order.subtotalPaise,
    status: order.status,
    cancelReason: order.cancelReason,
    source: order.source,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    preparingAt: iso(order.preparingAt),
    readyAt: iso(order.readyAt),
    deliveredAt: iso(order.deliveredAt),
    cancelledAt: iso(order.cancelledAt),
  };
}
