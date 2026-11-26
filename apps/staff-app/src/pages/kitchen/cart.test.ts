import type { MenuItemDto } from '@hospitality/shared-types';
import { describe, expect, it } from 'vitest';
import {
  cartEstimate,
  describeSelections,
  lineEstimate,
  missingRequired,
  toOrderItems,
  toggleSelection,
  type CartLine,
} from './cart';

const paneer: MenuItemDto = {
  id: 'm1',
  name: 'Paneer Butter Masala',
  category: 'Mains',
  description: '',
  pricePaise: 32_000,
  available: true,
  hasImage: false,
  createdAt: '',
  updatedAt: '',
  options: [
    {
      name: 'Spice level',
      required: true,
      multiple: false,
      choices: [
        { label: 'Mild', pricePaise: 0 },
        { label: 'Hot', pricePaise: 0 },
      ],
    },
    {
      name: 'Add-ons',
      required: false,
      multiple: true,
      choices: [
        { label: 'Extra cheese', pricePaise: 3_000 },
        { label: 'Butter naan', pricePaise: 5_000 },
      ],
    },
  ],
};

const chai: MenuItemDto = {
  ...paneer,
  id: 'm2',
  name: 'Masala Chai',
  pricePaise: 8_000,
  options: [],
};

describe('toggleSelection', () => {
  it('replaces the choice in a pick-one group', () => {
    const first = toggleSelection(paneer, [], 'Spice level', 'Mild', true);
    const second = toggleSelection(paneer, first, 'Spice level', 'Hot', true);
    expect(second).toEqual([{ group: 'Spice level', choice: 'Hot' }]);
  });

  it('keeps several choices in an add-on group, and removes one when it is unticked', () => {
    let selections = toggleSelection(paneer, [], 'Add-ons', 'Extra cheese', true);
    selections = toggleSelection(paneer, selections, 'Add-ons', 'Butter naan', true);
    expect(selections).toHaveLength(2);
    selections = toggleSelection(paneer, selections, 'Add-ons', 'Extra cheese', false);
    expect(selections).toEqual([{ group: 'Add-ons', choice: 'Butter naan' }]);
  });

  it('does not touch other groups and never mutates its input', () => {
    const original = [{ group: 'Spice level', choice: 'Hot' }];
    const next = toggleSelection(paneer, original, 'Add-ons', 'Butter naan', true);
    expect(original).toEqual([{ group: 'Spice level', choice: 'Hot' }]);
    expect(next).toEqual([
      { group: 'Spice level', choice: 'Hot' },
      { group: 'Add-ons', choice: 'Butter naan' },
    ]);
  });
});

describe('missingRequired', () => {
  it('names the required groups that have no choice yet', () => {
    expect(missingRequired(paneer, [])).toEqual(['Spice level']);
    expect(missingRequired(paneer, [{ group: 'Add-ons', choice: 'Butter naan' }])).toEqual([
      'Spice level',
    ]);
  });

  it('is empty once every required group is chosen, and for items with no options', () => {
    expect(missingRequired(paneer, [{ group: 'Spice level', choice: 'Hot' }])).toEqual([]);
    expect(missingRequired(chai, [])).toEqual([]);
  });
});

describe('estimates', () => {
  it('adds the extras to the price and multiplies by the quantity', () => {
    const selections = [
      { group: 'Spice level', choice: 'Hot' },
      { group: 'Add-ons', choice: 'Extra cheese' },
    ];
    expect(lineEstimate(paneer, 2, selections)).toBe(70_000);
    expect(lineEstimate(chai, 3, [])).toBe(24_000);
  });

  it('ignores a selection that is not on the item', () => {
    expect(lineEstimate(chai, 1, [{ group: 'Size', choice: 'Large' }])).toBe(8_000);
  });

  it('totals the cart', () => {
    const lines: CartLine[] = [
      {
        key: 'a',
        item: paneer,
        quantity: 2,
        selections: [{ group: 'Spice level', choice: 'Hot' }],
        note: '',
      },
      { key: 'b', item: chai, quantity: 1, selections: [], note: '' },
    ];
    expect(cartEstimate(lines)).toBe(72_000);
    expect(cartEstimate([])).toBe(0);
  });
});

describe('describeSelections and toOrderItems', () => {
  it('lists the chosen options in a readable line', () => {
    expect(
      describeSelections([
        { group: 'Spice level', choice: 'Hot' },
        { group: 'Add-ons', choice: 'Extra cheese' },
      ]),
    ).toBe('Hot, Extra cheese');
    expect(describeSelections([])).toBe('');
  });

  it('builds the order body with ids, quantities and choices only, never a price or a name', () => {
    const lines: CartLine[] = [
      {
        key: 'a',
        item: paneer,
        quantity: 2,
        selections: [{ group: 'Spice level', choice: 'Hot' }],
        note: 'no onion',
      },
    ];
    expect(toOrderItems(lines)).toEqual([
      {
        menuItemId: 'm1',
        quantity: 2,
        selections: [{ group: 'Spice level', choice: 'Hot' }],
        note: 'no onion',
      },
    ]);
  });
});
