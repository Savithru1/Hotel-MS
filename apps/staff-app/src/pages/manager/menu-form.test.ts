import type { MenuItemDto } from '@hospitality/shared-types';
import { describe, expect, it } from 'vitest';
import {
  buildMenuPayload,
  emptyMenuForm,
  formFromItem,
  paiseToRupees,
  rupeesToPaise,
} from './menu-form';

describe('rupeesToPaise', () => {
  it.each([
    ['320', 32_000],
    ['320.5', 32_050],
    ['320.50', 32_050],
    ['0.01', 1],
    ['  45 ', 4_500],
    ['1,250', 125_000],
  ])('reads %s as %i paise', (text, paise) => {
    expect(rupeesToPaise(text)).toBe(paise);
  });

  it.each(['', '  ', 'abc', '-5', '1.234', '1e3', '12.', '₹100', '0x10'])('refuses %j', (text) => {
    expect(rupeesToPaise(text)).toBeNull();
  });

  it('does not lose a paisa to floating point', () => {
    expect(rupeesToPaise('19.99')).toBe(1_999);
    expect(rupeesToPaise('0.07')).toBe(7);
    expect(rupeesToPaise('1.15')).toBe(115);
  });
});

describe('paiseToRupees', () => {
  it('shows whole rupees plainly and keeps two decimals otherwise', () => {
    expect(paiseToRupees(32_000)).toBe('320');
    expect(paiseToRupees(32_050)).toBe('320.50');
    expect(paiseToRupees(1)).toBe('0.01');
  });

  it('round-trips with rupeesToPaise', () => {
    for (const paise of [1, 99, 100, 1_999, 32_050, 999_999]) {
      expect(rupeesToPaise(paiseToRupees(paise))).toBe(paise);
    }
  });
});

describe('buildMenuPayload', () => {
  const filled = () => ({
    ...emptyMenuForm(),
    name: '  Paneer Butter Masala ',
    category: ' Mains ',
    price: '320.50',
  });

  it('turns a filled form into the body the API expects, in paise, trimmed', () => {
    const result = buildMenuPayload(filled());
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Paneer Butter Masala',
        category: 'Mains',
        description: '',
        pricePaise: 32_050,
        available: true,
        options: [],
      },
    });
  });

  it('converts option extras to paise and keeps the required and multiple flags', () => {
    const form = {
      ...filled(),
      options: [
        {
          name: ' Add-ons ',
          required: false,
          multiple: true,
          choices: [
            { label: 'Extra cheese', extra: '30' },
            { label: ' Butter naan ', extra: '' },
          ],
        },
      ],
    };
    const result = buildMenuPayload(form);
    expect(result.ok && result.value.options).toEqual([
      {
        name: 'Add-ons',
        required: false,
        multiple: true,
        choices: [
          { label: 'Extra cheese', pricePaise: 3_000 },
          { label: 'Butter naan', pricePaise: 0 },
        ],
      },
    ]);
  });

  it.each([
    ['a missing name', { name: '  ' }, /name/i],
    ['a missing category', { category: '' }, /category/i],
    ['a price that is not a number', { price: 'abc' }, /price/i],
    ['a price of zero', { price: '0' }, /price/i],
    ['a price that is too high', { price: '99999' }, /price/i],
  ])('explains %s', (_label, change, message) => {
    const result = buildMenuPayload({ ...filled(), ...change });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(message);
  });

  it('refuses an option group with no name, no choices or a bad extra price', () => {
    const group = {
      name: 'Size',
      required: false,
      multiple: false,
      choices: [{ label: 'Large', extra: '20' }],
    };
    for (const bad of [
      { ...group, name: '' },
      { ...group, choices: [] },
      { ...group, choices: [{ label: '', extra: '' }] },
      { ...group, choices: [{ label: 'Large', extra: 'lots' }] },
    ]) {
      expect(buildMenuPayload({ ...filled(), options: [bad] }).ok).toBe(false);
    }
  });
});

describe('formFromItem', () => {
  it('fills the form from an existing item, with prices back in rupees', () => {
    const item: MenuItemDto = {
      id: 'm1',
      name: 'Fresh Lime Soda',
      category: 'Drinks',
      description: 'Sweet or salted',
      pricePaise: 9_000,
      available: false,
      hasImage: true,
      createdAt: '',
      updatedAt: '',
      options: [
        {
          name: 'Size',
          required: false,
          multiple: false,
          choices: [
            { label: 'Regular', pricePaise: 0 },
            { label: 'Large', pricePaise: 2_000 },
          ],
        },
      ],
    };
    const form = formFromItem(item);
    expect(form).toMatchObject({
      name: 'Fresh Lime Soda',
      category: 'Drinks',
      description: 'Sweet or salted',
      price: '90',
      available: false,
    });
    expect(form.options[0]?.choices).toEqual([
      { label: 'Regular', extra: '' },
      { label: 'Large', extra: '20' },
    ]);
    // Editing without touching anything must give back the same prices.
    const payload = buildMenuPayload(form);
    expect(payload.ok && payload.value.pricePaise).toBe(9_000);
    expect(payload.ok && payload.value.options[0]?.choices[1]?.pricePaise).toBe(2_000);
  });
});
