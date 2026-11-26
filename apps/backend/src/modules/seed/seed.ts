import { STAFF_ROLES, defaultDepartments, type StaffRole } from '@hospitality/constants';
import type { Types } from 'mongoose';
import { hashPassword } from '../../shared/password';
import { runAsPlatform, runWithTenant } from '../../shared/request-context';
import { Property } from '../properties/property.model';
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
}

export const SEED_PROPERTIES: readonly SeedProperty[] = [
  { name: 'Grand Plaza', slug: 'grand-plaza', emailDomain: 'grandplaza.example' },
  { name: 'Sea View Resort', slug: 'sea-view', emailDomain: 'seaview.example' },
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
        { $setOnInsert: { name: definition.name, slug: definition.slug, active: true } },
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

    seeded.push({ id: property._id, name: definition.name, slug: definition.slug, staff });
  }

  return seeded;
}
