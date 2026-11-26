import { STAFF_ROLES } from '@hospitality/constants';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, canOpen, homePathFor, isManager, isPropertyAdmin, navFor } from './permissions';

describe('menu by role', () => {
  it('shows the front desk the booking pages and the two work queues, but no setup pages', () => {
    const paths = navFor('front_desk').map((item) => item.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/front-desk',
        '/bookings',
        '/guests',
        '/housekeeping',
        '/maintenance',
      ]),
    );
    expect(paths).not.toContain('/staff');
    expect(paths).not.toContain('/room-types');
    expect(paths).not.toContain('/property');
  });

  it('shows housekeeping only housekeeping, and maintenance only maintenance', () => {
    expect(navFor('housekeeping').map((item) => item.path)).toEqual(['/housekeeping']);
    expect(navFor('maintenance').map((item) => item.path)).toEqual(['/maintenance']);
  });

  it('shows the kitchen its own screen, and spa staff nothing yet (their dashboard is later)', () => {
    expect(navFor('kitchen').map((item) => item.path)).toEqual(['/kitchen']);
    expect(navFor('spa_recreation')).toEqual([]);
  });

  it('lets the front desk open the kitchen screen, but only management edit the menu', () => {
    expect(canOpen('front_desk', '/kitchen')).toBe(true);
    expect(canOpen('front_desk', '/menu')).toBe(false);
    expect(canOpen('kitchen', '/menu')).toBe(false);
    for (const role of ['manager', 'property_admin', 'platform_admin'] as const) {
      expect(canOpen(role, '/menu')).toBe(true);
      expect(canOpen(role, '/kitchen')).toBe(true);
    }
    for (const role of ['housekeeping', 'maintenance', 'spa_recreation'] as const) {
      expect(canOpen(role, '/kitchen')).toBe(false);
    }
  });

  it('shows managers and admins everything', () => {
    for (const role of ['manager', 'property_admin', 'platform_admin'] as const) {
      expect(navFor(role)).toHaveLength(NAV_ITEMS.length);
    }
  });

  it('never lets housekeeping open the maintenance queue, or the other way round', () => {
    expect(canOpen('housekeeping', '/maintenance')).toBe(false);
    expect(canOpen('maintenance', '/housekeeping')).toBe(false);
  });

  it('refuses unknown pages for everyone', () => {
    for (const role of STAFF_ROLES) expect(canOpen(role, '/secret')).toBe(false);
  });
});

describe('landing page and role helpers', () => {
  it('lands the kitchen on the kitchen screen', () => {
    expect(homePathFor('kitchen')).toBe('/kitchen');
  });

  it('sends each role to a page it may open', () => {
    for (const role of STAFF_ROLES) {
      const home = homePathFor(role);
      expect(home === '/welcome' || canOpen(role, home), `${role} -> ${home}`).toBe(true);
    }
  });

  it('knows who is a manager and who can edit the property', () => {
    expect(isManager('manager')).toBe(true);
    expect(isManager('front_desk')).toBe(false);
    expect(isPropertyAdmin('property_admin')).toBe(true);
    expect(isPropertyAdmin('manager')).toBe(false);
  });
});
