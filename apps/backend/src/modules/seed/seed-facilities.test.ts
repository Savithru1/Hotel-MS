import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { runWithTenant } from '../../shared/request-context';
import { Facility } from '../facilities/facility.model';
import { seedDevelopmentData, type SeededProperty } from './seed';
import { seedDevelopmentFacilities } from './seed-facilities';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

describe('seedDevelopmentFacilities', () => {
  it('gives a property a spa, a pool and a gym with sensible hours, slots and prices', async () => {
    const created = await seedDevelopmentFacilities(a.id);
    expect(created).toBeGreaterThanOrEqual(3);

    const facilities = await runWithTenant(a.id, () => Facility.find({}).lean());
    expect(facilities).toHaveLength(created);
    const types = new Set(facilities.map((f) => f.type));
    for (const type of ['spa', 'pool', 'gym', 'activity']) expect(types).toContain(type);
    for (const facility of facilities) {
      expect(Number.isInteger(facility.pricePaise)).toBe(true);
      expect(facility.capacity).toBeGreaterThanOrEqual(1);
      expect(facility.opensAt < facility.closesAt).toBe(true);
    }
    // The spa is used by one booking at a time; the pool is shared.
    expect(facilities.find((f) => f.type === 'spa')?.capacity).toBe(1);
    expect(facilities.find((f) => f.type === 'pool')?.capacity).toBeGreaterThan(1);
  });

  it('can run again without creating duplicates', async () => {
    const before = await runWithTenant(a.id, () => Facility.countDocuments({}));
    expect(await seedDevelopmentFacilities(a.id)).toBe(0);
    expect(await runWithTenant(a.id, () => Facility.countDocuments({}))).toBe(before);
  });

  it('keeps each property’s facilities inside that property', async () => {
    expect(await runWithTenant(b.id, () => Facility.countDocuments({}))).toBe(0);
    await seedDevelopmentFacilities(b.id);
    const mine = await runWithTenant(a.id, () => Facility.countDocuments({}));
    expect(await runWithTenant(b.id, () => Facility.countDocuments({}))).toBe(mine);
  });
});
