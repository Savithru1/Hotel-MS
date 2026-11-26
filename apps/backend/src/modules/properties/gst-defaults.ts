import type { GstRuleSet } from '@hospitality/shared-types';

/**
 * Starting tax rules for a new property, from plan section 3.4. These are this project's
 * understanding of Indian GST for hotels and MUST be confirmed by the property's accountant
 * before real invoices are issued. They are data, not code: a correction is a new effective-dated
 * rule set added in the property settings, and bills that were already issued keep the rates
 * they were issued with.
 *
 * Room tariff per night: up to Rs 1,000 nil; Rs 1,001 to 7,500 at 5%; above Rs 7,500 at 18%.
 * Food at 5%, or 18% where the room tariff is above Rs 7,500. Spa, gym, recreation and other
 * services at 18%.
 */
export function defaultGstRuleSet(effectiveFrom: string): GstRuleSet {
  return {
    effectiveFrom,
    room: {
      slabs: [
        { upToPaise: 100_000, ratePercent: 0 },
        { upToPaise: 750_000, ratePercent: 5 },
        { upToPaise: null, ratePercent: 18 },
      ],
    },
    food: { ratePercent: 5, highTariffThresholdPaise: 750_000, highTariffRatePercent: 18 },
    spaRecreation: { ratePercent: 18 },
    other: { ratePercent: 18 },
  };
}

export const DEFAULT_GST_EFFECTIVE_FROM = '2025-04-01';
