import { STAFF_ROLES } from '@hospitality/constants';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { runAsPlatform, runWithTenant } from '../../shared/request-context';
import { Property } from '../properties/property.model';
import { Staff } from '../staff/staff.model';
import { SEED_PASSWORD, seedDevelopmentData } from './seed';

useTestDatabase();

describe('seedDevelopmentData', () => {
  it('creates two properties with one staff member per role', async () => {
    const seeded = await seedDevelopmentData({ bcryptCost: 4 });
    expect(seeded).toHaveLength(2);
    const [first, second] = seeded;

    for (const role of STAFF_ROLES) {
      expect(first?.staff[role], `first property ${role}`).toBeDefined();
      if (role !== 'platform_admin')
        expect(second?.staff[role], `second property ${role}`).toBeDefined();
    }
    expect(second?.staff.platform_admin).toBeUndefined();
  });

  it('keeps each property’s staff inside that property', async () => {
    const [first, second] = await seedDevelopmentData({ bcryptCost: 4 });
    if (!first || !second) throw new Error('seed failed');

    const inFirst = await runWithTenant(first.id, () => Staff.find().lean());
    const inSecond = await runWithTenant(second.id, () => Staff.find().lean());
    expect(inFirst.every((staff) => staff.propertyId.equals(first.id))).toBe(true);
    expect(inSecond.every((staff) => staff.propertyId.equals(second.id))).toBe(true);
    expect(inFirst.length).toBe(STAFF_ROLES.length);
    expect(inSecond.length).toBe(STAFF_ROLES.length - 1);
  });

  it('can run twice without creating duplicates', async () => {
    await seedDevelopmentData({ bcryptCost: 4 });
    await seedDevelopmentData({ bcryptCost: 4 });
    expect(await runAsPlatform(() => Property.countDocuments())).toBe(2);
    expect(await runAsPlatform(() => Staff.countDocuments())).toBe(STAFF_ROLES.length * 2 - 1);
  });

  it('gives every account the documented development password, hashed', async () => {
    const [first] = await seedDevelopmentData({ bcryptCost: 4 });
    if (!first) throw new Error('seed failed');
    const staff = await runWithTenant(first.id, () =>
      Staff.findOne().select('+passwordHash').lean(),
    );
    expect(staff?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(staff?.passwordHash).not.toContain(SEED_PASSWORD);
  });
});
