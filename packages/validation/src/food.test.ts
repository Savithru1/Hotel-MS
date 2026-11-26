import { MAX_LINE_QUANTITY, MAX_MENU_PRICE_PAISE } from '@hospitality/constants';
import { describe, expect, it } from 'vitest';
import {
  cancelFoodOrderSchema,
  createFoodOrderSchema,
  createMenuItemSchema,
  listFoodOrdersQuerySchema,
  listMenuQuerySchema,
  updateMenuItemSchema,
} from './food';

const ID = '0123456789abcdef01234567';

const validItem = {
  name: 'Paneer Butter Masala',
  category: 'Main course',
  pricePaise: 32_000,
};

describe('createMenuItemSchema', () => {
  it('accepts a minimal item and fills the defaults', () => {
    expect(createMenuItemSchema.parse(validItem)).toEqual({
      ...validItem,
      description: '',
      options: [],
      available: true,
    });
  });

  it('trims text', () => {
    const parsed = createMenuItemSchema.parse({
      ...validItem,
      name: '  Dal  ',
      category: ' Main ',
    });
    expect(parsed.name).toBe('Dal');
    expect(parsed.category).toBe('Main');
  });

  it('rejects a missing name, an empty category and a non-integer or out-of-range price', () => {
    for (const bad of [
      { ...validItem, name: '' },
      { ...validItem, category: '   ' },
      { ...validItem, pricePaise: 0 },
      { ...validItem, pricePaise: -5 },
      { ...validItem, pricePaise: 10.5 },
      { ...validItem, pricePaise: MAX_MENU_PRICE_PAISE + 1 },
      { ...validItem, pricePaise: '320' },
    ]) {
      expect(createMenuItemSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('accepts customisation options with optional extra prices', () => {
    const parsed = createMenuItemSchema.parse({
      ...validItem,
      options: [
        {
          name: 'Spice level',
          required: true,
          choices: [{ label: 'Mild' }, { label: 'Hot' }],
        },
        {
          name: 'Add-ons',
          multiple: true,
          choices: [{ label: 'Extra cheese', pricePaise: 3_000 }],
        },
      ],
    });
    expect(parsed.options[0]).toMatchObject({ required: true, multiple: false });
    expect(parsed.options[0]?.choices[0]).toEqual({ label: 'Mild', pricePaise: 0 });
    expect(parsed.options[1]).toMatchObject({ required: false, multiple: true });
  });

  it('rejects option groups with no choices, negative extra prices or duplicate names', () => {
    const group = (extra: object) => ({ name: 'Size', choices: [{ label: 'Small' }], ...extra });
    for (const options of [
      [group({ choices: [] })],
      [group({ choices: [{ label: 'Small', pricePaise: -1 }] })],
      [group({ choices: [{ label: 'Small' }, { label: 'small' }] })],
      [group({}), group({ name: 'size' })],
    ]) {
      expect(createMenuItemSchema.safeParse({ ...validItem, options }).success).toBe(false);
    }
  });

  it('ignores fields it does not know about, such as a property id', () => {
    const parsed = createMenuItemSchema.parse({ ...validItem, propertyId: ID, imageId: ID });
    expect(parsed).not.toHaveProperty('propertyId');
    expect(parsed).not.toHaveProperty('imageId');
  });
});

describe('updateMenuItemSchema', () => {
  it('accepts a partial change without resetting anything else to a default', () => {
    expect(updateMenuItemSchema.parse({ available: false })).toEqual({ available: false });
    expect(updateMenuItemSchema.parse({ pricePaise: 100 })).toEqual({ pricePaise: 100 });
  });

  it('refuses an empty change', () => {
    expect(updateMenuItemSchema.safeParse({}).success).toBe(false);
  });

  it('applies the same limits as creating', () => {
    expect(updateMenuItemSchema.safeParse({ pricePaise: 0 }).success).toBe(false);
    expect(updateMenuItemSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('createFoodOrderSchema', () => {
  const line = { menuItemId: ID, quantity: 2 };

  it('accepts an order of items for a room and fills the defaults', () => {
    const parsed = createFoodOrderSchema.parse({ roomId: ID, items: [line] });
    expect(parsed).toEqual({
      roomId: ID,
      notes: '',
      items: [{ menuItemId: ID, quantity: 2, selections: [], note: '' }],
    });
  });

  it('never accepts a price, name or total from the client', () => {
    const parsed = createFoodOrderSchema.parse({
      roomId: ID,
      subtotalPaise: 1,
      items: [{ ...line, unitPricePaise: 1, name: 'Free lunch', lineTotalPaise: 1 }],
    });
    expect(parsed).not.toHaveProperty('subtotalPaise');
    expect(parsed.items[0]).not.toHaveProperty('unitPricePaise');
    expect(parsed.items[0]).not.toHaveProperty('name');
    expect(parsed.items[0]).not.toHaveProperty('lineTotalPaise');
  });

  it('rejects an empty order, bad ids and bad quantities', () => {
    for (const bad of [
      { roomId: ID, items: [] },
      { roomId: 'nope', items: [line] },
      { roomId: ID, items: [{ ...line, menuItemId: 'nope' }] },
      { roomId: ID, items: [{ ...line, quantity: 0 }] },
      { roomId: ID, items: [{ ...line, quantity: 1.5 }] },
      { roomId: ID, items: [{ ...line, quantity: MAX_LINE_QUANTITY + 1 }] },
      { roomId: ID, items: Array.from({ length: 31 }, () => line) },
      { roomId: ID },
    ]) {
      expect(createFoodOrderSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('takes chosen options by group and choice name', () => {
    const parsed = createFoodOrderSchema.parse({
      roomId: ID,
      items: [{ ...line, selections: [{ group: 'Spice level', choice: 'Hot' }], note: 'no onion' }],
    });
    expect(parsed.items[0]?.selections).toEqual([{ group: 'Spice level', choice: 'Hot' }]);
    expect(parsed.items[0]?.note).toBe('no onion');
  });

  it('caps note lengths', () => {
    expect(
      createFoodOrderSchema.safeParse({ roomId: ID, items: [line], notes: 'x'.repeat(301) })
        .success,
    ).toBe(false);
    expect(
      createFoodOrderSchema.safeParse({ roomId: ID, items: [{ ...line, note: 'x'.repeat(121) }] })
        .success,
    ).toBe(false);
  });
});

describe('list and cancel schemas', () => {
  it('parses menu and order list filters from a query string', () => {
    expect(listMenuQuerySchema.parse({ available: 'true', category: 'Starters' })).toMatchObject({
      available: true,
      category: 'Starters',
      page: 1,
    });
    expect(
      listFoodOrdersQuerySchema.parse({ open: 'true', status: 'preparing', limit: '10' }),
    ).toMatchObject({ open: true, status: 'preparing', limit: 10 });
    expect(listFoodOrdersQuerySchema.safeParse({ status: 'burnt' }).success).toBe(false);
    expect(listFoodOrdersQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('needs a reason to cancel an order', () => {
    expect(cancelFoodOrderSchema.parse({ reason: ' Guest changed their mind ' })).toEqual({
      reason: 'Guest changed their mind',
    });
    expect(cancelFoodOrderSchema.safeParse({}).success).toBe(false);
    expect(cancelFoodOrderSchema.safeParse({ reason: 'x' }).success).toBe(false);
  });
});
