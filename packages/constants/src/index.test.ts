import { describe, expect, it } from 'vitest';
import { ROOM_STATUSES, STAFF_ROLES } from './index';

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
