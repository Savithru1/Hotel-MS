import type { GstRuleSet } from '@hospitality/shared-types';
import { describe, expect, it } from 'vitest';
import { defaultGstRuleSet } from '../properties/gst-defaults';
import {
  computeLineTax,
  financialYear,
  gstinStateName,
  isIntraState,
  roundHalfUp,
  selectRuleSet,
  summarise,
} from './gst';

const RULES: GstRuleSet[] = [defaultGstRuleSet('2025-04-01')];
const intra = { rules: RULES, intraState: true };
const inter = { rules: RULES, intraState: false };

/** A room night at the given nightly tariff, in rupees. */
const night = (rupees: number, ctx = intra) =>
  computeLineTax(
    {
      category: 'room',
      taxablePaise: rupees * 100,
      serviceDate: '2026-11-26',
      tariffPaise: rupees * 100,
    },
    ctx,
  );

describe('roundHalfUp', () => {
  it('rounds .5 up and symmetrically away from zero for negatives', () => {
    expect(roundHalfUp(5, 2)).toBe(3);
    expect(roundHalfUp(4, 2)).toBe(2);
    expect(roundHalfUp(7, 3)).toBe(2);
    expect(roundHalfUp(-5, 2)).toBe(-3);
    expect(roundHalfUp(-7, 3)).toBe(-2);
    expect(roundHalfUp(0, 7)).toBe(0);
  });

  it('never returns negative zero', () => {
    expect(Object.is(roundHalfUp(-40, 100), 0)).toBe(true);
    expect(Object.is(roundHalfUp(-49, 100), 0)).toBe(true);
    expect(Object.is(roundHalfUp(-50, 100), -1)).toBe(true);
  });
});

describe('choosing the rule set by date', () => {
  const second: GstRuleSet = {
    ...defaultGstRuleSet('2026-07-01'),
    spaRecreation: { ratePercent: 12 },
  };

  it('uses the latest rules that have started, and the new ones on their first day', () => {
    const rules = [RULES[0] as GstRuleSet, second];
    expect(selectRuleSet(rules, '2026-06-30').effectiveFrom).toBe('2025-04-01');
    expect(selectRuleSet(rules, '2026-07-01').effectiveFrom).toBe('2026-07-01');
    expect(selectRuleSet(rules, '2027-01-01').effectiveFrom).toBe('2026-07-01');
  });

  it('does not depend on the order the rule sets are stored in', () => {
    expect(selectRuleSet([second, RULES[0] as GstRuleSet], '2026-08-01').effectiveFrom).toBe(
      '2026-07-01',
    );
  });

  it('refuses a date before any rules exist, rather than guessing a rate', () => {
    expect(() => selectRuleSet(RULES, '2025-03-31')).toThrow(/no tax rules/i);
    expect(() => selectRuleSet([], '2026-01-01')).toThrow(/no tax rules/i);
  });

  it('taxes a charge at the rate of the day it was supplied, not today’s', () => {
    const rules = [RULES[0] as GstRuleSet, second];
    const spa = (serviceDate: string) =>
      computeLineTax(
        { category: 'spa_recreation', taxablePaise: 100_000, serviceDate, tariffPaise: 450_000 },
        { rules, intraState: true },
      ).ratePercent;
    expect(spa('2026-06-30')).toBe(18);
    expect(spa('2026-07-01')).toBe(12);
  });
});

describe('room tax by nightly tariff (the slab boundaries)', () => {
  it.each([
    [999, 0],
    [1000, 0],
    [1001, 5],
    [4500, 5],
    [7500, 5],
    [7501, 18],
    [20000, 18],
  ])('taxes a Rs %i night at %i%%', (rupees, percent) => {
    expect(night(rupees).ratePercent).toBe(percent);
  });

  it('charges no tax at all on a Rs 1,000 night', () => {
    expect(night(1000)).toMatchObject({ taxPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
  });

  it('splits 5% on a Rs 4,500 night into equal CGST and SGST', () => {
    expect(night(4500)).toMatchObject({
      ratePercent: 5,
      cgstPaise: 11_250,
      sgstPaise: 11_250,
      igstPaise: 0,
      taxPaise: 22_500,
    });
  });

  it('uses IGST for a guest from another state, with the same total tax', () => {
    expect(night(4500, inter)).toMatchObject({
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 22_500,
      taxPaise: 22_500,
    });
    expect(night(10_000, inter).igstPaise).toBe(180_000);
    expect(night(10_000).cgstPaise).toBe(90_000);
  });

  it('uses the nightly tariff for the slab even when the taxable amount differs (a discounted night)', () => {
    const tax = computeLineTax(
      { category: 'room', taxablePaise: 100_000, serviceDate: '2026-11-26', tariffPaise: 450_000 },
      intra,
    );
    expect(tax.ratePercent).toBe(5);
    expect(tax.taxPaise).toBe(5_000);
  });
});

describe('food tax', () => {
  const food = (tariffRupees: number, taxable = 100_000) =>
    computeLineTax(
      {
        category: 'food',
        taxablePaise: taxable,
        serviceDate: '2026-11-26',
        tariffPaise: tariffRupees * 100,
      },
      intra,
    );

  it('is 5% in an ordinary room and 18% where the room tariff is above Rs 7,500', () => {
    expect(food(4500).ratePercent).toBe(5);
    expect(food(7500).ratePercent).toBe(5);
    expect(food(7501).ratePercent).toBe(18);
  });

  it('works out the tax on a typical order', () => {
    expect(food(4500, 78_000)).toMatchObject({
      cgstPaise: 1_950,
      sgstPaise: 1_950,
      taxPaise: 3_900,
    });
  });
});

describe('spa, recreation and other services', () => {
  it.each(['spa_recreation', 'other'] as const)('taxes %s at 18%%', (category) => {
    const tax = computeLineTax(
      { category, taxablePaise: 150_000, serviceDate: '2026-11-26', tariffPaise: 450_000 },
      intra,
    );
    expect(tax).toMatchObject({ ratePercent: 18, cgstPaise: 13_500, sgstPaise: 13_500 });
  });

  it('carries a SAC code for every category', () => {
    const codes = (['room', 'food', 'spa_recreation', 'other'] as const).map(
      (category) =>
        computeLineTax(
          { category, taxablePaise: 100, serviceDate: '2026-11-26', tariffPaise: 450_000 },
          intra,
        ).sacCode,
    );
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(new Set(codes).size).toBe(4);
  });
});

describe('rounding to whole paise', () => {
  const tax = (taxablePaise: number, ctx = intra) =>
    computeLineTax(
      { category: 'room', taxablePaise, serviceDate: '2026-11-26', tariffPaise: 450_000 },
      ctx,
    );

  it('rounds each half of the split on its own, so CGST and SGST are always equal', () => {
    // 5% of 333.33 = 16.6665: each half is 8.33325 -> 8.33
    expect(tax(33_333)).toMatchObject({ cgstPaise: 833, sgstPaise: 833, taxPaise: 1_666 });
  });

  it('rounds IGST once, on the whole tax', () => {
    expect(tax(33_333, inter)).toMatchObject({ igstPaise: 1_667, taxPaise: 1_667 });
  });

  it('rounds an exact half up for each half of the split', () => {
    expect(tax(100)).toMatchObject({ cgstPaise: 3, sgstPaise: 3, taxPaise: 6 });
  });

  it('gives a discount the mirror image of a charge', () => {
    const charge = tax(10_000);
    const discount = tax(-10_000);
    expect(discount.cgstPaise).toBe(-charge.cgstPaise);
    expect(discount.sgstPaise).toBe(-charge.sgstPaise);
    expect(discount.taxPaise).toBe(-charge.taxPaise);
    expect(tax(-100).cgstPaise).toBe(-3);
  });

  it('never returns a fractional paisa', () => {
    for (const taxable of [1, 7, 99, 101, 12_345, 99_999, 1_234_567]) {
      const result = tax(taxable);
      for (const value of [result.cgstPaise, result.sgstPaise, result.igstPaise, result.taxPaise]) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});

describe('totals and the round-off line', () => {
  const line = (taxablePaise: number, cgstPaise: number, sgstPaise: number, igstPaise = 0) => ({
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    taxPaise: cgstPaise + sgstPaise + igstPaise,
  });

  it('adds up every column and rounds the grand total to the nearest rupee', () => {
    const totals = summarise([line(100_000, 2_500, 2_500), line(23_000, 600, 601)]);
    expect(totals).toEqual({
      taxablePaise: 123_000,
      cgstPaise: 3_100,
      sgstPaise: 3_101,
      igstPaise: 0,
      taxPaise: 6_201,
      subtotalPaise: 129_201,
      roundOffPaise: -1,
      totalPaise: 129_200,
    });
  });

  it.each([
    [123_456, 44, 123_500],
    [123_449, -49, 123_400],
    [123_450, 50, 123_500],
    [123_400, 0, 123_400],
    [0, 0, 0],
    [-123_450, -50, -123_500],
  ])('rounds a subtotal of %i paise with a round-off of %i', (subtotal, roundOff, total) => {
    const totals = summarise([line(subtotal, 0, 0)]);
    expect(totals.roundOffPaise).toBe(roundOff);
    expect(totals.totalPaise).toBe(total);
    expect(Math.abs(totals.totalPaise % 100)).toBe(0);
  });

  it('gives all zeros for an empty bill', () => {
    expect(summarise([])).toEqual({
      taxablePaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
      taxPaise: 0,
      subtotalPaise: 0,
      roundOffPaise: 0,
      totalPaise: 0,
    });
  });
});

describe('financial year (April to March)', () => {
  it.each([
    ['2026-03-31', '2025-26'],
    ['2026-04-01', '2026-27'],
    ['2026-12-31', '2026-27'],
    ['2027-01-15', '2026-27'],
    ['2027-03-31', '2026-27'],
    ['2027-04-01', '2027-28'],
    ['2099-12-31', '2099-00'],
  ])('puts %s in %s', (date, year) => {
    expect(financialYear(date)).toBe(year);
  });
});

describe('place of supply', () => {
  it('reads the state from the first two digits of a GSTIN', () => {
    expect(gstinStateName('27AAAAA0000A1Z5')).toBe('Maharashtra');
    expect(gstinStateName('30AAAAA0000A1Z5')).toBe('Goa');
    expect(gstinStateName('07AAAAA0000A1Z5')).toBe('Delhi');
    expect(gstinStateName('29aaaaa0000a1z5')).toBe('Karnataka');
  });

  it('gives nothing for a GSTIN that does not start with a real state code', () => {
    expect(gstinStateName('99AAAAA0000A1Z5')).toBeNull();
    expect(gstinStateName('XXAAAAA0000A1Z5')).toBeNull();
    expect(gstinStateName('')).toBeNull();
    expect(gstinStateName(null)).toBeNull();
  });

  it('treats a guest with no GSTIN as being in the property’s state', () => {
    expect(isIntraState('Maharashtra', null)).toBe(true);
  });

  it('compares state names without caring about case or spaces', () => {
    expect(isIntraState('Maharashtra', 'maharashtra ')).toBe(true);
    expect(isIntraState('Maharashtra', 'Goa')).toBe(false);
  });
});
