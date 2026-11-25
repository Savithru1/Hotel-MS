import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

/**
 * Starts ONE in-memory MongoDB replica set for the whole test run (transactions need a replica
 * set). Every test file connects to its own throwaway database on it, see `test/db.ts`.
 */
let replSet: MongoMemoryReplSet | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // The first launch after the binary download can be slow (antivirus scan, cold disk).
    instanceOpts: [{ launchTimeout: 90_000 }],
  });
  project.provide('mongoUri', replSet.getUri());

  return async () => {
    await replSet?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
