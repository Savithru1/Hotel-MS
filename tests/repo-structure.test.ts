import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts: string[]): string => join(root, ...parts);

const WORKSPACE_PARENTS = ['apps', 'packages'] as const;

function workspaceDirs(): string[] {
  return WORKSPACE_PARENTS.flatMap((parent) =>
    readdirSync(at(parent))
      .map((name) => join(parent, name))
      .filter((dir) => statSync(at(dir)).isDirectory()),
  );
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('monorepo layout (spec section 5)', () => {
  const requiredDirs = [
    'apps/guest-app/public',
    'apps/guest-app/src/pages/auth',
    'apps/guest-app/src/pages/dashboard',
    'apps/guest-app/src/pages/food-ordering',
    'apps/guest-app/src/pages/service-requests',
    'apps/guest-app/src/pages/maintenance',
    'apps/guest-app/src/pages/facility-booking',
    'apps/guest-app/src/pages/billing',
    'apps/guest-app/src/pages/payments',
    'apps/staff-app/src/pages/login',
    'apps/staff-app/src/pages/kitchen',
    'apps/staff-app/src/pages/housekeeping',
    'apps/staff-app/src/pages/maintenance',
    'apps/staff-app/src/pages/spa-recreation',
    'apps/staff-app/src/pages/front-desk',
    'apps/staff-app/src/pages/manager',
    'apps/backend/src/config',
    'apps/backend/src/middleware',
    'apps/backend/src/shared',
    'apps/backend/src/utils',
    'packages/shared-types',
    'packages/validation',
    'packages/constants',
    'docs/architecture',
    'docs/api',
    'docs/database',
  ];

  it.each(requiredDirs)('has %s', (dir) => {
    expect(existsSync(at(dir))).toBe(true);
  });

  const backendModules = [
    'auth',
    'users',
    'properties',
    'bookings',
    'rooms',
    'food-orders',
    'service-requests',
    'maintenance',
    'housekeeping',
    'facilities',
    'billing',
    'payments',
    'notifications',
    'staff',
    'manager',
  ];

  it.each(backendModules)('has backend module folder %s', (name) => {
    expect(existsSync(at('apps/backend/src/modules', name))).toBe(true);
  });
});

describe('Phase 1 scope boundary (nothing from Phase 2 exists yet)', () => {
  const deferred = [
    'apps/backend/src/modules/trip-planner',
    'apps/backend/src/modules/recommendations',
    'apps/guest-app/src/pages/trip-planner',
    'apps/guest-app/src/pages/local-recommendations',
  ];

  it.each(deferred)('does not create %s', (dir) => {
    expect(existsSync(at(dir))).toBe(false);
  });
});

describe('MongoDB is the only database', () => {
  const forbiddenPackages = [
    'redis',
    'ioredis',
    'pg',
    'postgres',
    'mysql',
    'mysql2',
    'sqlite3',
    'better-sqlite3',
    'firebase',
    'firebase-admin',
    '@supabase/supabase-js',
    '@prisma/client',
    'prisma',
    'typeorm',
    'sequelize',
    'knex',
    'drizzle-orm',
  ];

  it('no workspace depends on another database or database client', () => {
    const manifests = ['.', ...workspaceDirs()].map((dir) => at(dir, 'package.json'));
    const offenders: string[] = [];
    for (const manifest of manifests) {
      const json = readJson(manifest);
      const deps = {
        ...(json.dependencies as Record<string, string> | undefined),
        ...(json.devDependencies as Record<string, string> | undefined),
      };
      for (const name of Object.keys(deps)) {
        if (forbiddenPackages.includes(name)) offenders.push(`${manifest}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('docker compose runs MongoDB and no other data store', () => {
    const compose = readFileSync(at('docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/image:\s*mongo:/);
    expect(compose).not.toMatch(/image:\s*(redis|postgres|mysql|mariadb|memcached|elasticsearch)/i);
  });
});

describe('workspace hygiene', () => {
  it('every workspace has the scripts the root commands rely on', () => {
    for (const dir of workspaceDirs()) {
      const json = readJson(at(dir, 'package.json'));
      const scripts = json.scripts as Record<string, string> | undefined;
      expect(scripts?.typecheck, `${dir} typecheck script`).toBeTruthy();
      expect(scripts?.test, `${dir} test script`).toBeTruthy();
    }
  });

  it('.env.example exists and holds no real-looking secrets', () => {
    const example = readFileSync(at('.env.example'), 'utf8');
    expect(example).toMatch(/MONGODB_URI=/);
    expect(example).not.toMatch(/sk_live|rzp_live/);
  });
});
