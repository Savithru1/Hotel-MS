import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { runWithTenant } from '../../shared/request-context';
import { MenuItem } from '../menu/menu-item.model';
import { seedDevelopmentData, type SeededProperty } from './seed';
import { seedDevelopmentMenu } from './seed-menu';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

describe('seedDevelopmentMenu', () => {
  it('gives a property a sample menu with categories, options and a sold-out item', async () => {
    const created = await seedDevelopmentMenu(a.id);
    expect(created).toBeGreaterThanOrEqual(8);

    const items = await runWithTenant(a.id, () => MenuItem.find({}).lean());
    expect(items).toHaveLength(created);
    expect(new Set(items.map((item) => item.category)).size).toBeGreaterThanOrEqual(3);
    expect(items.some((item) => item.options.length > 0)).toBe(true);
    expect(items.some((item) => item.options.some((group) => group.required))).toBe(true);
    expect(items.some((item) => !item.available)).toBe(true);
    for (const item of items) {
      expect(Number.isInteger(item.pricePaise)).toBe(true);
      expect(item.pricePaise).toBeGreaterThan(0);
    }
  });

  it('can run again without creating duplicates', async () => {
    const before = await runWithTenant(a.id, () => MenuItem.countDocuments({}));
    const created = await seedDevelopmentMenu(a.id);
    expect(created).toBe(0);
    expect(await runWithTenant(a.id, () => MenuItem.countDocuments({}))).toBe(before);
  });

  it('keeps each property’s menu inside that property', async () => {
    expect(await runWithTenant(b.id, () => MenuItem.countDocuments({}))).toBe(0);
    await seedDevelopmentMenu(b.id);
    const mine = await runWithTenant(a.id, () => MenuItem.countDocuments({}));
    const theirs = await runWithTenant(b.id, () => MenuItem.countDocuments({}));
    expect(theirs).toBe(mine);
  });
});
