import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES,
  HOUSEKEEPING_STATUSES,
  HOUSEKEEPING_TRANSITIONS,
  MAINTENANCE_STATUSES,
  MAINTENANCE_TRANSITIONS,
  BOOKING_STATUSES,
  BOOKING_TRANSITIONS,
  BILL_LINE_KINDS,
  BILL_STATUSES,
  GST_CATEGORIES,
  MANUAL_APPROVAL_LIMIT_PAISE,
  MANUAL_LINE_CATEGORIES,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  SAC_CODES,
  FACILITY_BOOKING_STATUSES,
  FACILITY_BOOKING_TRANSITIONS,
  FACILITY_HOLDING_STATUSES,
  FACILITY_TYPES,
  MAX_FACILITY_CAPACITY,
  MAX_SLOT_MINUTES,
  MIN_SLOT_MINUTES,
  FOOD_ORDER_OPEN_STATUSES,
  FOOD_ORDER_STATUSES,
  FOOD_ORDER_TRANSITIONS,
  LATE_ORDER_MINUTES,
  MAX_LINE_QUANTITY,
  MAX_MENU_PRICE_PAISE,
  MENU_IMAGE_TYPES,
  NIGHT_HOLDING_STATUSES,
  MANUAL_ROOM_STATUSES,
  ROOM_STATUS_TRANSITIONS,
  DEPARTMENTS,
  ROLE_RANK,
  ROOM_STATUSES,
  STAFF_ROLES,
  defaultDepartments,
  outranks,
} from './index';

describe('STAFF_ROLES', () => {
  it('lists every staff role from the plan, with no duplicates', () => {
    expect([...STAFF_ROLES].sort()).toEqual(
      [
        'front_desk',
        'housekeeping',
        'kitchen',
        'maintenance',
        'manager',
        'platform_admin',
        'property_admin',
        'spa_recreation',
      ].sort(),
    );
    expect(new Set(STAFF_ROLES).size).toBe(STAFF_ROLES.length);
  });

  it('does not treat guests as staff', () => {
    expect(STAFF_ROLES).not.toContain('guest' as never);
  });
});

describe('ROOM_STATUSES', () => {
  it('lists the six room states from the plan, with no duplicates', () => {
    expect([...ROOM_STATUSES].sort()).toEqual(
      ['available', 'cleaning', 'maintenance', 'occupied', 'out_of_service', 'reserved'].sort(),
    );
    expect(new Set(ROOM_STATUSES).size).toBe(ROOM_STATUSES.length);
  });
});

describe('departments and role ranking', () => {
  it('gives each department role its own single department', () => {
    expect(defaultDepartments('kitchen')).toEqual(['kitchen']);
    expect(defaultDepartments('front_desk')).toEqual(['front_desk']);
  });

  it('gives managers and admins every department', () => {
    for (const role of ['manager', 'property_admin', 'platform_admin'] as const) {
      expect(defaultDepartments(role)).toEqual([...DEPARTMENTS]);
    }
  });

  it('only lets a role manage strictly lower roles', () => {
    expect(outranks('property_admin', 'manager')).toBe(true);
    expect(outranks('manager', 'front_desk')).toBe(true);
    expect(outranks('manager', 'manager')).toBe(false);
    expect(outranks('manager', 'property_admin')).toBe(false);
    expect(outranks('front_desk', 'kitchen')).toBe(false);
  });

  it('ranks every staff role', () => {
    for (const role of STAFF_ROLES) expect(ROLE_RANK[role]).toBeGreaterThan(0);
  });

  it('never offers platform_admin for assignment', () => {
    expect(ASSIGNABLE_ROLES).not.toContain('platform_admin');
    expect(ASSIGNABLE_ROLES).toContain('manager');
  });
});

describe('room status transitions', () => {
  it('has a row for every status and only points at real statuses', () => {
    for (const status of ROOM_STATUSES) {
      expect(ROOM_STATUS_TRANSITIONS[status]).toBeDefined();
      for (const next of ROOM_STATUS_TRANSITIONS[status]) expect(ROOM_STATUSES).toContain(next);
    }
  });

  it('only lets an occupied room go to cleaning, and never lets a status loop to itself', () => {
    expect(ROOM_STATUS_TRANSITIONS.occupied).toEqual(['cleaning']);
    for (const status of ROOM_STATUSES) {
      expect(ROOM_STATUS_TRANSITIONS[status]).not.toContain(status);
    }
  });

  it('leaves booking-driven statuses out of the manual list', () => {
    expect(MANUAL_ROOM_STATUSES).not.toContain('occupied' as never);
    expect(MANUAL_ROOM_STATUSES).not.toContain('reserved' as never);
  });
});

describe('booking workflow', () => {
  it('has a row for every status and ends in the three terminal states', () => {
    for (const status of BOOKING_STATUSES) expect(BOOKING_TRANSITIONS[status]).toBeDefined();
    const terminal = BOOKING_STATUSES.filter((s) => BOOKING_TRANSITIONS[s].length === 0);
    expect(terminal.sort()).toEqual(['cancelled', 'checked_out', 'no_show']);
  });

  it('only releases the room nights of finished bookings', () => {
    expect(NIGHT_HOLDING_STATUSES).toEqual(['pending', 'confirmed', 'checked_in']);
  });

  it('cannot go straight from pending to checked in', () => {
    expect(BOOKING_TRANSITIONS.pending).not.toContain('checked_in');
  });
});

describe('food order workflow', () => {
  it('moves received -> preparing -> ready -> delivered, one step at a time', () => {
    expect(FOOD_ORDER_TRANSITIONS.received).toContain('preparing');
    expect(FOOD_ORDER_TRANSITIONS.preparing).toEqual(['ready']);
    expect(FOOD_ORDER_TRANSITIONS.ready).toEqual(['delivered']);
    expect(FOOD_ORDER_TRANSITIONS.received).not.toContain('delivered');
    expect(FOOD_ORDER_TRANSITIONS.received).not.toContain('ready');
  });

  it('only allows cancelling before preparation starts', () => {
    expect(FOOD_ORDER_TRANSITIONS.received).toContain('cancelled');
    expect(FOOD_ORDER_TRANSITIONS.preparing).not.toContain('cancelled');
    expect(FOOD_ORDER_TRANSITIONS.ready).not.toContain('cancelled');
  });

  it('ends in delivered or cancelled with no way back', () => {
    expect(FOOD_ORDER_TRANSITIONS.delivered).toEqual([]);
    expect(FOOD_ORDER_TRANSITIONS.cancelled).toEqual([]);
    const terminal = FOOD_ORDER_STATUSES.filter((s) => FOOD_ORDER_TRANSITIONS[s].length === 0);
    expect(terminal.sort()).toEqual(['cancelled', 'delivered']);
  });

  it('has a row for every status and only points at real statuses', () => {
    for (const status of FOOD_ORDER_STATUSES) {
      expect(FOOD_ORDER_TRANSITIONS[status]).toBeDefined();
      for (const next of FOOD_ORDER_TRANSITIONS[status])
        expect(FOOD_ORDER_STATUSES).toContain(next);
    }
  });

  it('counts received, preparing and ready as open', () => {
    expect([...FOOD_ORDER_OPEN_STATUSES]).toEqual(['received', 'preparing', 'ready']);
  });

  it('has sane limits for late orders, prices, quantities and images', () => {
    expect(LATE_ORDER_MINUTES).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_MENU_PRICE_PAISE)).toBe(true);
    expect(MAX_LINE_QUANTITY).toBeGreaterThan(0);
    // Only raster formats a browser shows safely. SVG can carry scripts, so it is not listed.
    expect([...MENU_IMAGE_TYPES].sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });
});

describe('facility booking workflow', () => {
  it('moves requested -> confirmed -> active -> completed, one step at a time', () => {
    expect(FACILITY_BOOKING_TRANSITIONS.requested).toContain('confirmed');
    expect(FACILITY_BOOKING_TRANSITIONS.confirmed).toContain('active');
    expect(FACILITY_BOOKING_TRANSITIONS.active).toEqual(['completed']);
    expect(FACILITY_BOOKING_TRANSITIONS.requested).not.toContain('active');
    expect(FACILITY_BOOKING_TRANSITIONS.confirmed).not.toContain('completed');
  });

  it('can be cancelled before it starts, and marked no-show only once confirmed', () => {
    expect(FACILITY_BOOKING_TRANSITIONS.requested).toContain('cancelled');
    expect(FACILITY_BOOKING_TRANSITIONS.confirmed).toContain('cancelled');
    expect(FACILITY_BOOKING_TRANSITIONS.confirmed).toContain('no_show');
    expect(FACILITY_BOOKING_TRANSITIONS.requested).not.toContain('no_show');
    expect(FACILITY_BOOKING_TRANSITIONS.active).not.toContain('cancelled');
  });

  it('ends in completed, cancelled or no-show with no way back', () => {
    const terminal = FACILITY_BOOKING_STATUSES.filter(
      (s) => FACILITY_BOOKING_TRANSITIONS[s].length === 0,
    );
    expect(terminal.sort()).toEqual(['cancelled', 'completed', 'no_show']);
  });

  it('has a row for every status and only points at real statuses', () => {
    for (const status of FACILITY_BOOKING_STATUSES) {
      expect(FACILITY_BOOKING_TRANSITIONS[status]).toBeDefined();
      for (const next of FACILITY_BOOKING_TRANSITIONS[status]) {
        expect(FACILITY_BOOKING_STATUSES).toContain(next);
      }
    }
  });

  it('holds a place in the slot while requested, confirmed or active, and not afterwards', () => {
    expect([...FACILITY_HOLDING_STATUSES]).toEqual(['requested', 'confirmed', 'active']);
  });

  it('lists the facility types and sane capacity and slot limits', () => {
    expect([...FACILITY_TYPES].sort()).toEqual(['activity', 'gym', 'other', 'pool', 'spa']);
    expect(MAX_FACILITY_CAPACITY).toBeGreaterThan(1);
    expect(MIN_SLOT_MINUTES).toBeLessThan(MAX_SLOT_MINUTES);
  });
});

describe('billing constants', () => {
  it('has the two bill statuses and the five kinds of bill line', () => {
    expect([...BILL_STATUSES]).toEqual(['open', 'finalized']);
    expect([...BILL_LINE_KINDS].sort()).toEqual(['charge', 'discount', 'facility', 'food', 'room']);
  });

  it('knows the four tax categories and has a SAC code for each', () => {
    expect([...GST_CATEGORIES].sort()).toEqual(['food', 'other', 'room', 'spa_recreation']);
    for (const category of GST_CATEGORIES) expect(SAC_CODES[category]).toMatch(/^\d{6}$/);
  });

  it('only lets staff add manual charges under the categories that have a simple tax rule', () => {
    expect([...MANUAL_LINE_CATEGORIES].sort()).toEqual(['food', 'other', 'spa_recreation']);
    expect(MANUAL_LINE_CATEGORIES).not.toContain('room' as never);
  });

  it('lists the payment methods and kinds', () => {
    expect([...PAYMENT_METHODS].sort()).toEqual(['bank_transfer', 'card', 'cash', 'other', 'upi']);
    expect([...PAYMENT_KINDS].sort()).toEqual(['payment', 'refund']);
  });

  it('sets a whole-paise limit above which a manager has to approve a manual charge', () => {
    expect(Number.isInteger(MANUAL_APPROVAL_LIMIT_PAISE)).toBe(true);
    expect(MANUAL_APPROVAL_LIMIT_PAISE).toBeGreaterThan(0);
  });
});

describe('housekeeping and maintenance workflows', () => {
  it('moves housekeeping new -> in progress -> completed, with cancel only before work starts', () => {
    expect(HOUSEKEEPING_TRANSITIONS.new).toEqual(['in_progress', 'cancelled']);
    expect(HOUSEKEEPING_TRANSITIONS.in_progress).toEqual(['completed']);
    expect(HOUSEKEEPING_TRANSITIONS.completed).toEqual([]);
    expect(HOUSEKEEPING_TRANSITIONS.cancelled).toEqual([]);
  });

  it('moves maintenance new -> assigned -> in progress -> resolved, and never skips assignment', () => {
    expect(MAINTENANCE_TRANSITIONS.new).toEqual(['assigned']);
    expect(MAINTENANCE_TRANSITIONS.assigned).toContain('in_progress');
    expect(MAINTENANCE_TRANSITIONS.assigned).not.toContain('resolved');
    expect(MAINTENANCE_TRANSITIONS.resolved).toEqual([]);
  });

  it('has a row for every status', () => {
    for (const s of HOUSEKEEPING_STATUSES) expect(HOUSEKEEPING_TRANSITIONS[s]).toBeDefined();
    for (const s of MAINTENANCE_STATUSES) expect(MAINTENANCE_TRANSITIONS[s]).toBeDefined();
  });
});
