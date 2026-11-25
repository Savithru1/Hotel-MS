import mongoose from 'mongoose';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from './database';

afterEach(async () => {
  await disconnectDatabase();
});

describe('database connection', () => {
  it('connects, reports healthy, and disconnects', async () => {
    expect(isDatabaseConnected()).toBe(false);
    await connectDatabase(inject('mongoUri'), { dbName: 'database_connect_test' });
    expect(isDatabaseConnected()).toBe(true);
    await disconnectDatabase();
    expect(isDatabaseConnected()).toBe(false);
  });

  it('can be disconnected twice without error', async () => {
    await connectDatabase(inject('mongoUri'), { dbName: 'database_connect_test' });
    await disconnectDatabase();
    await expect(disconnectDatabase()).resolves.toBeUndefined();
  });

  it('fails with a clear error, and never leaks credentials, when unreachable', async () => {
    let message = '';
    try {
      await connectDatabase('mongodb://app-user:s3cretpw@127.0.0.1:1/x', {
        serverSelectionTimeoutMS: 300,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/could not connect to mongodb/i);
    expect(message).not.toContain('s3cretpw');
    expect(isDatabaseConnected()).toBe(false);
  });

  it('turns on strict query filtering', async () => {
    await connectDatabase(inject('mongoUri'), { dbName: 'database_connect_test' });
    expect(mongoose.get('strictQuery')).toBe(true);
  });
});
