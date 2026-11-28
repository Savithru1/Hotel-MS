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

  it('shows the kitchen its own screen, and spa staff theirs', () => {
    expect(navFor('kitchen').map((item) => item.path)).toEqual(['/kitchen']);
    expect(navFor('spa_recreation').map((item) => item.path)).toEqual(['/spa']);
  });

  it('lets the front desk open the spa screen, but only management edit facilities', () => {
    expect(canOpen('front_desk', '/spa')).toBe(true);
    expect(canOpen('front_desk', '/facilities')).toBe(false);
    expect(canOpen('spa_recreation', '/facilities')).toBe(false);
    for (const role of ['manager', 'property_admin', 'platform_admin'] as const) {
      expect(canOpen(role, '/facilities')).toBe(true);
      expect(canOpen(role, '/spa')).toBe(true);
    }
    for (const role of ['kitchen', 'housekeeping', 'maintenance'] as const) {
      expect(canOpen(role, '/spa')).toBe(false);
    }
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

describe('billing screens', () => {
  it('are for the front desk and management, never for the other departments', () => {
    for (const path of ['/bills', '/payments']) {
      for (const role of ['front_desk', 'manager', 'property_admin', 'platform_admin'] as const) {
        expect(canOpen(role, path)).toBe(true);
      }
      for (const role of ['kitchen', 'housekeeping', 'maintenance', 'spa_recreation'] as const) {
        expect(canOpen(role, path)).toBe(false);
      }
    }
  });
});

describe('manager screens', () => {
  const MANAGER_PAGES = ['/manager', '/manager/stats', '/audit'];

  it('are open to every management role and to no other role', () => {
    for (const path of MANAGER_PAGES) {
      for (const role of STAFF_ROLES) {
        const management = ['manager', 'property_admin', 'platform_admin'].includes(role);
        expect(canOpen(role, path), `${role} ${path}`).toBe(management);
      }
    }
  });

  it('sit together in a Manager menu group, shown to management only', () => {
    for (const role of STAFF_ROLES) {
      const grouped = navFor(role).filter((item) => item.group === 'Manager');
      const expected = ['manager', 'property_admin', 'platform_admin'].includes(role)
        ? MANAGER_PAGES
        : [];
      expect(grouped.map((item) => item.path)).toEqual(expected);
    }
  });
});

describe('landing page and role helpers', () => {
  it('lands every management role on the manager dashboard', () => {
    for (const role of ['manager', 'property_admin', 'platform_admin'] as const) {
      expect(homePathFor(role)).toBe('/manager');
    }
    expect(homePathFor('front_desk')).toBe('/front-desk');
  });

  it('lands the kitchen on the kitchen screen and spa staff on the spa screen', () => {
    expect(homePathFor('kitchen')).toBe('/kitchen');
    expect(homePathFor('spa_recreation')).toBe('/spa');
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
