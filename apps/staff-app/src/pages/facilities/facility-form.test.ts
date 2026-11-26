import type { FacilityDto } from '@hospitality/shared-types';
import { describe, expect, it } from 'vitest';
import { buildFacilityPayload, emptyFacilityForm, formFromFacility } from './facility-form';

const filled = () => ({
  ...emptyFacilityForm(),
  name: '  Ayurvedic Spa ',
  type: 'spa' as const,
  capacity: '1',
  slotMinutes: '60',
  opensAt: '09:00',
  closesAt: '18:00',
  price: '1500',
});

describe('buildFacilityPayload', () => {
  it('turns a filled form into the body the API expects, in paise, trimmed', () => {
    expect(buildFacilityPayload(filled())).toEqual({
      ok: true,
      value: {
        name: 'Ayurvedic Spa',
        type: 'spa',
        description: '',
        capacity: 1,
        slotMinutes: 60,
        opensAt: '09:00',
        closesAt: '18:00',
        pricePaise: 150_000,
        active: true,
      },
    });
  });

  it('accepts a free facility and a price with paise', () => {
    const free = buildFacilityPayload({ ...filled(), price: '0' });
    expect(free.ok && free.value.pricePaise).toBe(0);
    const odd = buildFacilityPayload({ ...filled(), price: '199.50' });
    expect(odd.ok && odd.value.pricePaise).toBe(19_950);
  });

  it.each([
    ['a missing name', { name: '  ' }, /name/i],
    ['a capacity that is not a whole number', { capacity: '1.5' }, /capacity/i],
    ['a capacity of zero', { capacity: '0' }, /capacity/i],
    ['a capacity that is too high', { capacity: '101' }, /capacity/i],
    ['a slot length that is not a number', { slotMinutes: 'long' }, /slot/i],
    ['a slot shorter than 15 minutes', { slotMinutes: '10' }, /slot/i],
    ['a slot length that is not a multiple of 5', { slotMinutes: '47' }, /slot/i],
    ['no opening time', { opensAt: '' }, /open/i],
    ['no closing time', { closesAt: '' }, /clos/i],
    ['closing before opening', { opensAt: '18:00', closesAt: '09:00' }, /after/i],
    ['hours too short for one slot', { opensAt: '09:00', closesAt: '09:30' }, /slot/i],
    ['a price that is not a number', { price: 'abc' }, /price/i],
    ['a price that is too high', { price: '999999' }, /price/i],
  ])('explains %s', (_label, change, message) => {
    const result = buildFacilityPayload({ ...filled(), ...change });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(message);
  });
});

describe('formFromFacility', () => {
  it('fills the form from an existing facility, and round-trips without changing anything', () => {
    const facility: FacilityDto = {
      id: 'f1',
      name: 'Rooftop Pool',
      type: 'pool',
      description: 'Shared pool',
      capacity: 8,
      slotMinutes: 30,
      opensAt: '07:00',
      closesAt: '20:00',
      pricePaise: 19_950,
      active: false,
      createdAt: '',
      updatedAt: '',
    };
    const form = formFromFacility(facility);
    expect(form).toMatchObject({
      name: 'Rooftop Pool',
      type: 'pool',
      capacity: '8',
      slotMinutes: '30',
      opensAt: '07:00',
      closesAt: '20:00',
      price: '199.50',
      active: false,
    });
    const payload = buildFacilityPayload(form);
    expect(payload.ok && payload.value).toMatchObject({
      pricePaise: 19_950,
      capacity: 8,
      slotMinutes: 30,
      active: false,
    });
  });
});
