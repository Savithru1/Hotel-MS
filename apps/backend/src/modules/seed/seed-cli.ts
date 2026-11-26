import { connectDatabase, disconnectDatabase } from '../../config/database';
import { loadEnv } from '../../config/environment';
import { SEED_PASSWORD, seedDevelopmentData } from './seed';
import { seedDevelopmentMenu } from './seed-menu';

/**
 * `pnpm --filter @hospitality/backend seed`. Creates the two development properties and their
 * staff. Refuses to run in production because the seed password is public.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed development data when NODE_ENV is "production".');
  }

  // The seed password is public, so only ever seed a database on this machine.
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?[/?]/.test(env.MONGODB_URI)) {
    throw new Error('Refusing to seed a database that is not on this machine (localhost).');
  }

  await connectDatabase(env.MONGODB_URI);
  try {
    const properties = await seedDevelopmentData({ bcryptCost: env.BCRYPT_COST });
    for (const property of properties) await seedDevelopmentMenu(property.id);
    const lines = properties.map(
      (property) =>
        `${property.name} (property link name: ${property.slug})\n` +
        Object.values(property.staff)
          .map((staff) => `  ${staff.role.padEnd(15)} ${staff.email}`)
          .join('\n'),
    );
    process.stdout.write(
      `Seeded development data.\n\n${lines.join('\n\n')}\n\nPassword for every account: ${SEED_PASSWORD}\n`,
    );
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Seeding failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
