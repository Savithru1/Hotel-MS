import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, inject } from 'vitest';

/**
 * Connects mongoose to a brand-new database on the shared in-memory replica set for the
 * duration of one test file, and drops it afterwards. Call once at the top of a test file.
 */
export function useTestDatabase(): void {
  const dbName = `test_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    await mongoose.connect(inject('mongoUri'), { dbName });
    // Unique indexes are what the duplicate checks finally rely on, so wait until they exist
    // instead of racing the first writes of the test file against the background index build.
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}

/** Two distinct property ids, for cross-tenant tests. */
export function twoTenants(): { a: Types.ObjectId; b: Types.ObjectId } {
  return { a: new Types.ObjectId(), b: new Types.ObjectId() };
}
