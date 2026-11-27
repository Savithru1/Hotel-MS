import { JOB_MAX_ATTEMPTS, type JobType } from '@hospitality/constants';
import type { Types } from 'mongoose';
import type { Logger } from 'pino';
import { Property } from '../modules/properties/property.model';
import { runAsPlatform, runWithTenant } from '../shared/request-context';
import { BackgroundJob } from './job.model';
import { systemClock, type Clock } from './worker';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_REFRESH_MS = 10 * MINUTE_MS;

export interface RecurringSpec {
  type: JobType;
  everyMs: number;
}

/** The jobs every active property gets. `billing.sync_open` is added when its handler exists. */
export const RECURRING_JOBS: readonly RecurringSpec[] = [
  { type: 'sla.scan', everyMs: MINUTE_MS },
  { type: 'notifications.cleanup', everyMs: 24 * HOUR_MS },
];

export interface SchedulerOptions {
  clock?: Clock;
  logger: Pick<Logger, 'error'>;
  specs?: readonly RecurringSpec[];
  /** How often `start()` checks for new properties. */
  refreshMs?: number;
}

export interface Scheduler {
  /** Makes sure every active property has its recurring jobs. Returns how many it created. */
  ensure(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

const dedupeKeyOf = (spec: RecurringSpec): string => `recurring:${spec.type}`;

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 11000;
}

export function createScheduler({
  clock = systemClock,
  logger,
  specs = RECURRING_JOBS,
  refreshMs = DEFAULT_REFRESH_MS,
}: SchedulerOptions): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | null = null;

  /** Inserts the job if this property does not have it yet; an existing one is never touched. */
  async function upsert(propertyId: Types.ObjectId, spec: RecurringSpec): Promise<number> {
    try {
      const result = await runWithTenant(propertyId, () =>
        BackgroundJob.updateOne(
          { dedupeKey: dedupeKeyOf(spec) },
          {
            $setOnInsert: {
              type: spec.type,
              payload: {},
              runAt: clock.now(),
              status: 'pending',
              attempts: 0,
              maxAttempts: JOB_MAX_ATTEMPTS,
              recurring: { everyMs: spec.everyMs },
            },
          },
          { upsert: true },
        ),
      );
      return result.upsertedCount;
    } catch (error) {
      // Another instance inserted it between our check and write: that is the outcome we want.
      if (isDuplicateKey(error)) return 0;
      throw error;
    }
  }

  /** A recurring job that gave up must not stay dead: a scan that stops is worse than a noisy one. */
  async function reviveFailed(): Promise<void> {
    await runAsPlatform(() =>
      BackgroundJob.updateMany(
        { status: 'failed', recurring: { $ne: null } },
        { $set: { status: 'pending', runAt: clock.now(), attempts: 0 } },
      ),
    );
  }

  async function ensure(): Promise<number> {
    const properties = await runAsPlatform(() =>
      Property.find({ active: true }, { _id: 1 }).lean(),
    );
    let created = 0;
    for (const property of properties) {
      for (const spec of specs) created += await upsert(property._id, spec);
    }
    await reviveFailed();
    return created;
  }

  function refresh(): void {
    if (inFlight) return;
    inFlight = ensure()
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Could not schedule the recurring jobs');
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return {
    ensure,
    start() {
      if (timer) return;
      timer = setInterval(refresh, refreshMs);
      timer.unref();
      refresh();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
