import { STAFF_ROLES, defaultDepartments, type StaffRole } from '@hospitality/constants';
import type { Types } from 'mongoose';
import { hashPassword } from '../../shared/password';
import { runAsPlatform, runWithTenant } from '../../shared/request-context';
import { Property } from '../properties/property.model';
import { Room } from '../rooms/room.model';
import { RoomType } from '../rooms/room-type.model';
import { Staff } from '../staff/staff.model';

/**
 * DEVELOPMENT AND TEST DATA ONLY. This password is public (it is in the repository) and the
 * seed command refuses to run when NODE_ENV is "production".
 */
export const SEED_PASSWORD = 'Seed-Pass-2026';

interface SeedProperty {
  name: string;
  slug: string;
  emailDomain: string;
  stateName: string;
}

/** Development room types. Tariffs are in paise (Rs 2,500 = 250,000). */
const SEED_ROOM_TYPES = [
  {
    name: 'Standard',
    capacity: 2,
    ratePaise: 250_000,
    amenities: ['Wi-Fi', 'TV', 'Air conditioning'],
  },
  {
    name: 'Deluxe',
    capacity: 3,
    ratePaise: 450_000,
    amenities: ['Wi-Fi', 'TV', 'Air conditioning', 'Mini bar'],
  },
  {
    name: 'Suite',
    capacity: 4,
    ratePaise: 900_000,
    amenities: ['Wi-Fi', 'TV', 'Air conditioning', 'Mini bar', 'Lounge'],
  },
] as const;

/** Room number -> room type name. Floor is the first digit. */
const SEED_ROOMS: Record<string, (typeof SEED_ROOM_TYPES)[number]['name']> = {
  '101': 'Standard',
  '102': 'Standard',
  '103': 'Standard',
  '104': 'Deluxe',
  '105': 'Deluxe',
  '201': 'Standard',
  '202': 'Deluxe',
  '203': 'Deluxe',
  '204': 'Deluxe',
  '205': 'Suite',
};

export const SEED_PROPERTIES: readonly SeedProperty[] = [
  {
    name: 'Grand Plaza',
    slug: 'grand-plaza',
    emailDomain: 'grandplaza.example',
    stateName: 'Maharashtra',
  },
  { name: 'Sea View Resort', slug: 'sea-view', emailDomain: 'seaview.example', stateName: 'Goa' },
];

export interface SeededStaff {
  id: Types.ObjectId;
  email: string;
  role: StaffRole;
}

export interface SeededProperty {
  id: Types.ObjectId;
  name: string;
  slug: string;
  staff: Partial<Record<StaffRole, SeededStaff>>;
}

export interface SeedOptions {
  bcryptCost: number;
}

/**
 * Creates two properties, each with one staff member per role (the platform admin only in the
 * first property). Safe to run again: existing records are left alone.
 */
export async function seedDevelopmentData({ bcryptCost }: SeedOptions): Promise<SeededProperty[]> {
  const passwordHash = await hashPassword(SEED_PASSWORD, bcryptCost);
  const seeded: SeededProperty[] = [];

  for (const [index, definition] of SEED_PROPERTIES.entries()) {
    const property = await runAsPlatform(() =>
      Property.findOneAndUpdate(
        { slug: definition.slug },
        {
          $setOnInsert: {
            name: definition.name,
            slug: definition.slug,
            legalName: `${definition.name} Private Limited`,
            stateName: definition.stateName,
            active: true,
          },
        },
        { upsert: true, returnDocument: 'after' },
      ),
    );
    if (!property) throw new Error(`Could not create property ${definition.slug}`);

    const staff: SeededProperty['staff'] = {};
    for (const role of STAFF_ROLES) {
      if (role === 'platform_admin' && index > 0) continue;
      const email = `${role.replace('_', '.')}@${definition.emailDomain}`;
      const doc = await runWithTenant(property._id, () =>
        Staff.findOneAndUpdate(
          { email },
          {
            $setOnInsert: {
              name: `${definition.name} ${role.replace('_', ' ')}`,
              email,
              passwordHash,
              role,
              departments: defaultDepartments(role),
              active: true,
              mustChangePassword: false,
            },
          },
          { upsert: true, returnDocument: 'after' },
        ),
      );
      if (!doc) throw new Error(`Could not create ${email}`);
      staff[role] = { id: doc._id, email, role };
    }

    await seedRooms(property._id);
    seeded.push({ id: property._id, name: definition.name, slug: definition.slug, staff });
  }

  return seeded;
}

async function seedRooms(propertyId: Types.ObjectId): Promise<void> {
  await runWithTenant(propertyId, async () => {
    const typeIds = new Map<string, Types.ObjectId>();
    for (const type of SEED_ROOM_TYPES) {
      const doc = await RoomType.findOneAndUpdate(
        { name: type.name },
        { $setOnInsert: { ...type, amenities: [...type.amenities] } },
        { upsert: true, returnDocument: 'after', collation: { locale: 'en', strength: 2 } },
      );
      if (!doc) throw new Error(`Could not create room type ${type.name}`);
      typeIds.set(type.name, doc._id);
    }
    for (const [number, typeName] of Object.entries(SEED_ROOMS)) {
      await Room.updateOne(
        { number },
        {
          $setOnInsert: {
            number,
            floor: Number(number[0]),
            roomTypeId: typeIds.get(typeName),
            status: 'available',
            history: [],
          },
        },
        { upsert: true, collation: { locale: 'en', strength: 2 } },
      );
    }
  });
}
