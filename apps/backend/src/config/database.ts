import mongoose from 'mongoose';

// Unknown fields in a query filter are dropped instead of silently matching everything.
mongoose.set('strictQuery', true);

export interface DatabaseOptions {
  dbName?: string;
  serverSelectionTimeoutMS?: number;
}

const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 10_000;

/** `user:pass@host1,host2/db?x` becomes `host1,host2`: safe to put in an error message. */
function hostsOf(uri: string): string {
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const withoutCredentials = withoutScheme.replace(/^[^@/]*@/, '');
  return withoutCredentials.split(/[/?]/)[0] ?? 'unknown host';
}

/**
 * Connects to MongoDB, the only database of this project. The error never contains the
 * connection string, so credentials cannot leak into logs.
 */
export async function connectDatabase(uri: string, options: DatabaseOptions = {}): Promise<void> {
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS:
        options.serverSelectionTimeoutMS ?? DEFAULT_SERVER_SELECTION_TIMEOUT_MS,
      ...(options.dbName ? { dbName: options.dbName } : {}),
    });
  } catch (error) {
    await mongoose.disconnect().catch(() => undefined);
    const reason = error instanceof Error ? error.name : 'unknown error';
    throw new Error(
      `Could not connect to MongoDB at ${hostsOf(uri)} (${reason}). ` +
        'Check MONGODB_URI and that the database is running.',
      { cause: error },
    );
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}
