import mongoose, { type ClientSession } from 'mongoose';

/**
 * Runs `fn` in a database transaction: everything it does commits together or not at all. A
 * transient conflict (two transactions touching the same document) is retried automatically.
 * Never emit events or send messages from inside `fn`: it can run more than once. Do that after
 * this function returns.
 */
export function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  return mongoose.connection.transaction(fn);
}
