import {
  FACILITY_TYPES,
  MAX_FACILITY_CAPACITY,
  MAX_FACILITY_PRICE_PAISE,
  MAX_SLOT_MINUTES,
  MIN_SLOT_MINUTES,
  type FacilityType,
} from '@hospitality/constants';
import type { FacilityDto } from '@hospitality/shared-types';
import { paiseToRupees, rupeesToPaise } from '../manager/menu-form';

/** The facility form as typed, before it is checked. Numbers and the price are text. */
export interface FacilityFormState {
  name: string;
  type: FacilityType;
  description: string;
  capacity: string;
  slotMinutes: string;
  opensAt: string;
  closesAt: string;
  /** Rupees per person per slot. */
  price: string;
  active: boolean;
}

/** The body the facilities API takes. The price is whole paise. */
export interface FacilityPayload {
  name: string;
  type: FacilityType;
  description: string;
  capacity: number;
  slotMinutes: number;
  opensAt: string;
  closesAt: string;
  pricePaise: number;
  active: boolean;
}

export type FacilityPayloadResult =
  { ok: true; value: FacilityPayload } | { ok: false; error: string };

export function emptyFacilityForm(): FacilityFormState {
  return {
    name: '',
    type: FACILITY_TYPES[0],
    description: '',
    capacity: '1',
    slotMinutes: '60',
    opensAt: '09:00',
    closesAt: '18:00',
    price: '',
    active: true,
  };
}

export function formFromFacility(facility: FacilityDto): FacilityFormState {
  return {
    name: facility.name,
    type: facility.type,
    description: facility.description,
    capacity: String(facility.capacity),
    slotMinutes: String(facility.slotMinutes),
    opensAt: facility.opensAt,
    closesAt: facility.closesAt,
    price: paiseToRupees(facility.pricePaise),
    active: facility.active,
  };
}

const fail = (error: string): FacilityPayloadResult => ({ ok: false, error });
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Checks the form and turns it into an API body, or says in plain words what to fix. */
export function buildFacilityPayload(form: FacilityFormState): FacilityPayloadResult {
  const name = form.name.trim();
  if (!name) return fail('Enter a name for the facility.');

  const capacityText = form.capacity.trim();
  const capacity = /^\d+$/.test(capacityText) ? Number(capacityText) : NaN;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_FACILITY_CAPACITY) {
    return fail(`Capacity must be a whole number from 1 to ${MAX_FACILITY_CAPACITY}.`);
  }

  const slotText = form.slotMinutes.trim();
  const slotMinutes = /^\d+$/.test(slotText) ? Number(slotText) : NaN;
  if (
    !Number.isInteger(slotMinutes) ||
    slotMinutes < MIN_SLOT_MINUTES ||
    slotMinutes > MAX_SLOT_MINUTES ||
    slotMinutes % 5 !== 0
  ) {
    return fail(
      `The slot length must be a whole number of minutes, a multiple of 5, from ${MIN_SLOT_MINUTES} to ${MAX_SLOT_MINUTES}.`,
    );
  }

  if (!TIME_OF_DAY.test(form.opensAt)) return fail('Enter the opening time.');
  if (!TIME_OF_DAY.test(form.closesAt)) return fail('Enter the closing time.');
  const span = minutes(form.closesAt) - minutes(form.opensAt);
  if (span <= 0) return fail('The closing time must be after the opening time.');
  if (span < slotMinutes) return fail('The opening hours are too short for even one slot.');

  const pricePaise = rupeesToPaise(form.price);
  if (pricePaise === null || pricePaise > MAX_FACILITY_PRICE_PAISE) {
    return fail('Enter a price from 0 to 1,00,000 rupees, like 1500 or 199.50. Use 0 for free.');
  }

  return {
    ok: true,
    value: {
      name,
      type: form.type,
      description: form.description.trim(),
      capacity,
      slotMinutes,
      opensAt: form.opensAt,
      closesAt: form.closesAt,
      pricePaise,
      active: form.active,
    },
  };
}
