import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES,
  HOUSEKEEPING_STATUSES,
  HOUSEKEEPING_TRANSITIONS,
  MAINTENANCE_STATUSES,
  MAINTENANCE_TRANSITIONS,
  BOOKING_STATUSES,
  BOOKING_TRANSITIONS,
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
