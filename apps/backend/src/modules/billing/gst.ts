import { SAC_CODES, type GstCategory } from '@hospitality/constants';
import type { GstRuleSet } from '@hospitality/shared-types';
import { gstinStateName } from './gst-states';

export { gstinStateName };

/** Thrown when no tax rules exist for a date. A bill is never taxed with a guessed rate. */
export class GstRulesError extends Error {
  constructor(date: string) {
    super(`There are no tax rules in effect for ${date}. Add a rule set in the property settings.`);
    this.name = 'GstRulesError';
  }
}

export interface TaxContext {
  /** All the property's effective-dated rule sets, in any order. */
  rules: readonly GstRuleSet[];
  /** CGST + SGST when true, IGST when false. */
  intraState: boolean;
}

export interface LineTaxInput {
  category: GstCategory;
  /** The value the tax is worked out on, in paise. Negative for a discount. */
  taxablePaise: number;
  /** The day the service was supplied, `YYYY-MM-DD` in the property's timezone. */
  serviceDate: string;
  /**
   * The booking's nightly room tariff in paise. For a room night it picks the slab; for food it
   * decides whether the higher "expensive room" rate applies.
   */
  tariffPaise: number;
}

export interface LineTax {
  ratePercent: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  sacCode: string;
  /** Which rule set was used, so the line records exactly what it was taxed under. */
  ruleEffectiveFrom: string;
}

export interface TaxColumns {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
}

export interface BillTotals extends TaxColumns {
  subtotalPaise: number;
  /** What rounding the grand total to a whole rupee added (or took off). */
  roundOffPaise: number;
  totalPaise: number;
}

/** Integer division that rounds half away from zero, so a discount mirrors the matching charge. */
export function roundHalfUp(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const magnitude = Math.abs(numerator);
  const rounded = Math.floor((2 * magnitude + denominator) / (2 * denominator));
  // A small negative amount rounds to 0, never to -0, which would be stored as a different number.
  return rounded === 0 ? 0 : sign * rounded;
}

/** The rules in force on `date`: the latest set whose first day is on or before it. */
export function selectRuleSet(rules: readonly GstRuleSet[], date: string): GstRuleSet {
  const inForce = rules
    .filter((rule) => rule.effectiveFrom <= date)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  const latest = inForce[0];
  if (!latest) throw new GstRulesError(date);
  return latest;
}

function ratePercentFor(rules: GstRuleSet, input: LineTaxInput): number {
  switch (input.category) {
    case 'room': {
      const slab = rules.room.slabs.find(
        (candidate) => candidate.upToPaise === null || input.tariffPaise <= candidate.upToPaise,
      );
      if (!slab) throw new Error('The room tax slabs do not cover this tariff');
      return slab.ratePercent;
    }
    case 'food':
      return input.tariffPaise > rules.food.highTariffThresholdPaise
        ? rules.food.highTariffRatePercent
        : rules.food.ratePercent;
    case 'spa_recreation':
      return rules.spaRecreation.ratePercent;
    case 'other':
      return rules.other.ratePercent;
  }
}

/**
 * Works out the tax on one bill line. Every figure is a whole number of paise. For CGST + SGST
 * each half is rounded on its own (so the two are always equal); IGST is rounded once on the
 * whole tax. A discount (negative taxable value) gets exactly the mirror image of a charge.
 */
export function computeLineTax(input: LineTaxInput, context: TaxContext): LineTax {
  const ruleSet = selectRuleSet(context.rules, input.serviceDate);
  const ratePercent = ratePercentFor(ruleSet, input);
  // Rates are held in hundredths of a percent so a rate like 2.5% stays an exact integer.
  const hundredths = Math.round(ratePercent * 100);
  const base = {
    ratePercent,
    sacCode: SAC_CODES[input.category],
    ruleEffectiveFrom: ruleSet.effectiveFrom,
  };

  if (context.intraState) {
    const half = roundHalfUp(input.taxablePaise * hundredths, 20_000);
    return { ...base, cgstPaise: half, sgstPaise: half, igstPaise: 0, taxPaise: half * 2 };
  }
  const igst = roundHalfUp(input.taxablePaise * hundredths, 10_000);
  return { ...base, cgstPaise: 0, sgstPaise: 0, igstPaise: igst, taxPaise: igst };
}

/** Adds up the lines and rounds the grand total to the nearest whole rupee (half away from zero). */
export function summarise(lines: readonly TaxColumns[]): BillTotals {
  const sum = (pick: (line: TaxColumns) => number): number =>
    lines.reduce((total, line) => total + pick(line), 0);
  const taxablePaise = sum((line) => line.taxablePaise);
  const taxPaise = sum((line) => line.taxPaise);
  const subtotalPaise = taxablePaise + taxPaise;
  const totalPaise = roundHalfUp(subtotalPaise, 100) * 100;
  return {
    taxablePaise,
    cgstPaise: sum((line) => line.cgstPaise),
    sgstPaise: sum((line) => line.sgstPaise),
    igstPaise: sum((line) => line.igstPaise),
    taxPaise,
    subtotalPaise,
    roundOffPaise: totalPaise - subtotalPaise,
    totalPaise,
  };
}

/** The Indian financial year (April to March) a date falls in, like `2026-27`. */
export function financialYear(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Whether tax is split into CGST + SGST (true) or charged as IGST (false). A guest with no GSTIN
 * is treated as being in the property's state; a guest with one is compared by the state in it.
 */
export function isIntraState(propertyState: string, placeOfSupplyState: string | null): boolean {
  if (placeOfSupplyState === null) return true;
  return propertyState.trim().toLowerCase() === placeOfSupplyState.trim().toLowerCase();
}
