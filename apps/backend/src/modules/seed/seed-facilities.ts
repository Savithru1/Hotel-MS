import type { FacilityType } from '@hospitality/constants';
import type { Types } from 'mongoose';
import { runWithTenant } from '../../shared/request-context';
import { Facility } from '../facilities/facility.model';

interface SeedFacility {
  name: string;
  type: FacilityType;
  description: string;
  capacity: number;
  slotMinutes: number;
  opensAt: string;
  closesAt: string;
  /** Rupees per person per slot, converted to paise when stored. */
  price: number;
}

/** DEVELOPMENT DATA ONLY: a small set of facilities so the spa and recreation screens have something to show. */
const SEED_FACILITIES: readonly SeedFacility[] = [
  {
    name: 'Ayurvedic Spa',
    type: 'spa',
    description: 'Massage and therapy rooms. One booking at a time.',
    capacity: 1,
    slotMinutes: 60,
    opensAt: '09:00',
    closesAt: '19:00',
    price: 1500,
  },
  {
    name: 'Rooftop Pool',
    type: 'pool',
    description: 'Shared pool, up to eight guests per slot.',
    capacity: 8,
    slotMinutes: 60,
    opensAt: '07:00',
    closesAt: '20:00',
    price: 200,
  },
  {
    name: 'Fitness Centre',
    type: 'gym',
    description: 'Gym floor, up to ten guests per slot. Free for guests.',
    capacity: 10,
    slotMinutes: 60,
    opensAt: '06:00',
    closesAt: '22:00',
    price: 0,
  },
  {
    name: 'Sunrise Yoga',
    type: 'activity',
    description: 'Guided morning session on the terrace.',
    capacity: 12,
    slotMinutes: 60,
    opensAt: '06:00',
    closesAt: '08:00',
    price: 300,
  },
];

/**
 * Adds the sample facilities to one property. A facility that already exists (by name) is left
 * alone, so it is safe to run twice. Returns how many were created.
 */
export async function seedDevelopmentFacilities(propertyId: Types.ObjectId): Promise<number> {
  return runWithTenant(propertyId, async () => {
    let created = 0;
    for (const facility of SEED_FACILITIES) {
      const result = await Facility.updateOne(
        { nameKey: facility.name.toLowerCase() },
        {
          $setOnInsert: {
            name: facility.name,
            nameKey: facility.name.toLowerCase(),
            type: facility.type,
            description: facility.description,
            capacity: facility.capacity,
            slotMinutes: facility.slotMinutes,
            opensAt: facility.opensAt,
            closesAt: facility.closesAt,
            pricePaise: facility.price * 100,
            active: true,
          },
        },
        { upsert: true },
      );
      created += result.upsertedCount;
    }
    return created;
  });
}
