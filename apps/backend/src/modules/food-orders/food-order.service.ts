import {
  FOOD_ORDER_OPEN_STATUSES,
  FOOD_ORDER_STATUSES,
  LATE_ORDER_MINUTES,
  type FoodOrderStatus,
} from '@hospitality/constants';
import type { FoodOrderDto, FoodOrderSummaryDto } from '@hospitality/shared-types';
import type { ClientSession } from 'mongoose';
import { recordAudit } from '../../shared/audit/audit';
import { badRequest, conflict, notFound } from '../../shared/errors';
import { eventBus, type EventBus } from '../../shared/events/event-bus';
import { generateReadableCode } from '../../shared/readable-code';
import { getContext } from '../../shared/request-context';
import { transition } from '../../shared/state-machine';
import { inTransaction } from '../../shared/transaction';
import type { AuthenticatedStaff } from '../auth/auth.types';
import { Booking } from '../bookings/booking.model';
import { MenuItem, type MenuItemDocument } from '../menu/menu-item.model';
import { Bill } from '../billing/bill.model';
import { Room } from '../rooms/room.model';
import { toFoodOrderDto } from './food-order.mapper';
import { FoodOrder, foodOrderMachine, type FoodOrderDocument } from './food-order.model';
import { priceLine, type OrderLineInput } from './food-order-pricing';

export interface CreateFoodOrderInput {
  roomId: string;
  items: OrderLineInput[];
  notes: string;
}

export interface ListFoodOrdersInput {
  page: number;
  limit: number;
  status?: FoodOrderStatus | undefined;
  open?: boolean | undefined;
  roomId?: string | undefined;
  bookingId?: string | undefined;
}

export interface FoodOrderService {
  create(actor: AuthenticatedStaff, input: CreateFoodOrderInput): Promise<FoodOrderDto>;
  list(input: ListFoodOrdersInput): Promise<{ items: FoodOrderDto[]; total: number }>;
  get(id: string): Promise<FoodOrderDto>;
  summary(): Promise<FoodOrderSummaryDto>;
  start(id: string): Promise<FoodOrderDto>;
  ready(id: string): Promise<FoodOrderDto>;
  deliver(id: string): Promise<FoodOrderDto>;
  cancel(id: string, reason: string): Promise<FoodOrderDto>;
}

const OPEN = [...FOOD_ORDER_OPEN_STATUSES];
const MAX_CODE_ATTEMPTS = 5;

function isCodeClash(error: unknown): boolean {
  const like = error as { code?: unknown; keyPattern?: Record<string, unknown> } | null;
  return like?.code === 11000 && like.keyPattern !== undefined && 'code' in like.keyPattern;
}

export function createFoodOrderService(bus: EventBus = eventBus): FoodOrderService {
  async function load(id: string): Promise<FoodOrderDocument> {
    const order = await FoodOrder.findOne({ _id: id }).lean();
    if (!order) throw notFound('Order not found');
    return order;
  }

  /** The kitchen, front desk and managers refetch the order list when they hear this. */
  function announce(order: FoodOrderDocument, change: string): void {
    bus.emit({
      type: 'food_order.changed',
      propertyId: order.propertyId,
      audience: { departments: ['kitchen', 'front_desk'] },
      data: {
        orderId: order._id.toHexString(),
        orderCode: order.code,
        roomId: order.roomId.toHexString(),
        roomNumber: order.roomNumber,
        status: order.status,
        change,
      },
    });
  }

  async function audit(
    action: string,
    order: FoodOrderDocument,
    extra: Record<string, unknown> = {},
    session?: ClientSession,
  ): Promise<void> {
    await recordAudit({
      action: `food_order.${action}`,
      target: { type: 'food_order', id: order._id.toHexString() },
      summary: {
        code: order.code,
        roomId: order.roomId.toHexString(),
        subtotalPaise: order.subtotalPaise,
        ...extra,
      },
      ...(session ? { session } : {}),
    });
  }

  /**
   * One legal step. The state machine makes sure only one of several racing callers wins.
   *
   * The step and its audit entry commit together. If the audit write fails the step is undone, so
   * an order can never be left delivered while the caller was told it failed (which would also
   * mean billing was never told, and a retry would only get a 409). Announcing happens after the
   * commit and cannot throw: a failing listener never affects the caller.
   */
  async function move(
    id: string,
    to: FoodOrderStatus,
    change: string,
    set: Record<string, unknown> = {},
    note?: string,
  ): Promise<FoodOrderDocument> {
    const order = await inTransaction(async (session) => {
      const moved = await transition({
        model: FoodOrder,
        id,
        machine: foodOrderMachine,
        to,
        set,
        session,
        ...(note ? { note } : {}),
      });
      const updated = moved.toObject();
      await audit(change, updated, note ? { reason: note } : {}, session);
      return updated;
    });
    announce(order, change);
    return order;
  }

  async function insertWithFreeCode(
    fields: Omit<FoodOrderDocument, '_id' | 'propertyId' | 'code' | 'createdAt' | 'updatedAt'>,
  ): Promise<FoodOrderDocument> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      try {
        const created = await FoodOrder.create({ ...fields, code: generateReadableCode('FO') });
        return created.toObject();
      } catch (error) {
        // Two orders drawing the same code is possible but rare: just draw again.
        if (!isCodeClash(error)) throw error;
      }
    }
    throw new Error('Could not find a free order code');
  }

  return {
    async create(actor, input) {
      const room = await Room.findOne({ _id: input.roomId, active: true }).lean();
      if (!room) throw badRequest('That room does not exist', 'unknown_room');

      const booking = await Booking.findOne({ roomId: room._id, status: 'checked_in' }).lean();
      if (!booking) {
        throw conflict(`Room ${room.number} has no guest checked in`, 'no_guest_in_room');
      }
      // Once the invoice is issued nothing more can be added, or it could never be billed.
      if (await Bill.exists({ bookingId: booking._id, status: 'finalized' })) {
        throw conflict(
          'This guest’s invoice has already been issued, so nothing more can be ordered',
          'invoice_issued',
        );
      }

      // Every price comes from the menu as it is right now. Nothing in the request is a price.
      const wanted = [...new Set(input.items.map((line) => line.menuItemId))];
      const found = await MenuItem.find({ _id: { $in: wanted } }).lean();
      const byId = new Map<string, MenuItemDocument>(
        found.map((item) => [item._id.toHexString(), item]),
      );
      if (wanted.some((id) => !byId.has(id.toLowerCase()))) {
        throw badRequest('One of the items is not on the menu', 'unknown_item');
      }
      const unavailable = [
        ...new Set(
          input.items
            .map((line) => byId.get(line.menuItemId.toLowerCase()))
            .filter((item): item is MenuItemDocument => item !== undefined && !item.available)
            .map((item) => item.name),
        ),
      ];
      if (unavailable.length > 0) {
        throw conflict(`Not available right now: ${unavailable.join(', ')}`, 'item_unavailable');
      }

      const items = input.items.map((line) => {
        const item = byId.get(line.menuItemId.toLowerCase());
        if (!item) throw badRequest('One of the items is not on the menu', 'unknown_item');
        return priceLine(item, line);
      });
      const subtotalPaise = items.reduce((sum, line) => sum + line.lineTotalPaise, 0);

      const principal = getContext()?.principal;
      const order = await insertWithFreeCode({
        roomId: room._id,
        roomNumber: room.number,
        bookingId: booking._id,
        guestName: booking.guestSnapshot.name,
        items,
        notes: input.notes,
        subtotalPaise,
        status: 'received',
        history: [
          { from: null, to: 'received', at: new Date(), ...(principal ? { by: principal } : {}) },
        ],
        source: actor.role === 'kitchen' ? 'kitchen' : 'front_desk',
        createdBy: actor.id.toHexString(),
        cancelReason: null,
        preparingAt: null,
        readyAt: null,
        deliveredAt: null,
        cancelledAt: null,
      });

      await audit('created', order, { lines: items.length });
      announce(order, 'created');
      return toFoodOrderDto(order);
    },

    async list(input) {
      const filter: Record<string, unknown> = {};
      if (input.status) filter.status = input.status;
      if (input.open) filter.status = { $in: OPEN };
      if (input.roomId) filter.roomId = input.roomId;
      if (input.bookingId) filter.bookingId = input.bookingId;

      // The kitchen works through open orders oldest first. A history view wants the newest first,
      // and for delivered orders "newest" means delivered most recently, not placed most recently.
      const working = input.open || (input.status !== undefined && OPEN.includes(input.status));
      const order: Record<string, 1 | -1> = working
        ? { createdAt: 1, _id: 1 }
        : input.status === 'delivered'
          ? { deliveredAt: -1, _id: -1 }
          : { createdAt: -1, _id: -1 };

      const [items, total] = await Promise.all([
        FoodOrder.find(filter)
          .sort(order)
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        FoodOrder.countDocuments(filter),
      ]);
      return { items: items.map(toFoodOrderDto), total };
    },

    async get(id) {
      return toFoodOrderDto(await load(id));
    },

    async summary() {
      const lateBefore = new Date(Date.now() - LATE_ORDER_MINUTES * 60_000);
      const [rows, late] = await Promise.all([
        FoodOrder.aggregate<{ _id: FoodOrderStatus; count: number }>([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        FoodOrder.countDocuments({ status: { $in: OPEN }, createdAt: { $lt: lateBefore } }),
      ]);
      const byStatus = Object.fromEntries(FOOD_ORDER_STATUSES.map((status) => [status, 0]));
      for (const row of rows) byStatus[row._id] = row.count;
      return { byStatus, late };
    },

    async start(id) {
      const order = await move(id, 'preparing', 'started', { preparingAt: new Date() });
      return toFoodOrderDto(order);
    },

    async ready(id) {
      const order = await move(id, 'ready', 'ready', { readyAt: new Date() });
      return toFoodOrderDto(order);
    },

    async deliver(id) {
      const order = await move(id, 'delivered', 'delivered', { deliveredAt: new Date() });
      // Only the caller whose update really moved the order gets here, so billing hears it once.
      bus.emit({
        type: 'order.delivered',
        propertyId: order.propertyId,
        // No screen needs this. Billing listens on the bus itself (P1.10).
        audience: { managers: false },
        data: {
          orderId: order._id.toHexString(),
          bookingId: order.bookingId.toHexString(),
          roomId: order.roomId.toHexString(),
          subtotalPaise: order.subtotalPaise,
        },
      });
      return toFoodOrderDto(order);
    },

    async cancel(id, reason) {
      const order = await move(
        id,
        'cancelled',
        'cancelled',
        {
          cancelReason: reason,
          cancelledAt: new Date(),
        },
        reason,
      );
      return toFoodOrderDto(order);
    },
  };
}
