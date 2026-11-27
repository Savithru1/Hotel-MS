import { randomUUID } from 'node:crypto';
import {
  JOB_BACKOFF_BASE_MS,
  JOB_BACKOFF_MAX_MS,
  JOB_LEASE_MS,
  type JobType,
} from '@hospitality/constants';
import type { Types } from 'mongoose';
import type { Logger } from 'pino';
import { managersOf } from '../modules/notifications/managers';
import type { NotificationService } from '../modules/notifications/notification.service';
import { recordAudit } from '../shared/audit/audit';
import {
  runAsPlatform,
  runWithContext,
  type Principal,
  type RequestContext,
} from '../shared/request-context';
import { BackgroundJob, JOB_ERROR_MAX_CHARS, type JobDocument } from './job.model';

const SYSTEM: Principal = { kind: 'system', id: 'system' };
const DEFAULT_MAX_JOBS_PER_TICK = 25;

/** Where the worker gets "now" from. Tests pass a fake one. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** What a handler is told about the job it is running. */
export interface JobView {
  id: string;
  type: JobType;
  propertyId: Types.ObjectId;
  payload: Record<string, unknown>;
  /** 1 on the first run. */
  attempt: number;
}

/**
 * Runs inside the job's property with a system principal, so every model call is already
 * limited to that property. A handler must be safe to run twice: a crash after the work but
 * before the job is marked finished makes the job run again once its lease runs out.
 */
export type JobHandler = (job: JobView) => Promise<void>;

export interface WorkerOptions {
  clock?: Clock;
  /** How often `start()` looks for work. */
  pollMs: number;
  handlers: Partial<Record<JobType, JobHandler>>;
  logger: Pick<Logger, 'error' | 'info'>;
  notifications: Pick<NotificationService, 'notify'>;
  /** A tick stops after this many jobs so one busy tick cannot run forever. */
  maxJobsPerTick?: number;
}

export interface Worker {
  /** Runs every job that is due now, one after the other. Returns how many it ran. */
  tick(): Promise<number>;
  /** Starts polling. The timer never keeps the process alive and ticks never overlap. */
  start(): void;
  /** Stops polling and waits for the job in flight to finish. */
  stop(): Promise<void>;
}

export function backoffMs(attempts: number): number {
  return Math.min(JOB_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), JOB_BACKOFF_MAX_MS);
}

/** The message only, cut short. A stack trace could leak paths and internals. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, JOB_ERROR_MAX_CHARS);
}

export function createWorker({
  clock = systemClock,
  pollMs,
  handlers,
  logger,
  notifications,
  maxJobsPerTick = DEFAULT_MAX_JOBS_PER_TICK,
}: WorkerOptions): Worker {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | null = null;
  let stopping = false;

  const inProperty = <T>(job: JobDocument, fn: () => T): T => {
    const context: RequestContext = { propertyId: job.propertyId, principal: SYSTEM };
    return runWithContext(context, fn);
  };

  /**
   * One atomic update finds a due job (or a running one whose lease ran out, which means its
   * worker died) and takes it. Two workers can never both get the same one.
   */
  function claim(now: Date): Promise<JobDocument | null> {
    return runAsPlatform(() =>
      BackgroundJob.findOneAndUpdate(
        {
          $or: [
            { status: 'pending', runAt: { $lte: now } },
            { status: 'running', lockedUntil: { $lt: now } },
          ],
        },
        {
          $set: {
            status: 'running',
            lockedUntil: new Date(now.getTime() + JOB_LEASE_MS),
            lockToken: randomUUID(),
          },
          $inc: { attempts: 1 },
        },
        { sort: { runAt: 1 }, returnDocument: 'after' },
      ).lean(),
    );
  }

  /** Writes the outcome only if this worker still owns the claim. Null means it lost it. */
  function finish(job: JobDocument, changes: Record<string, unknown>): Promise<JobDocument | null> {
    return runAsPlatform(() =>
      BackgroundJob.findOneAndUpdate(
        { _id: job._id, lockToken: job.lockToken },
        { $set: { lockedUntil: null, lockToken: null, lastFinishedAt: clock.now(), ...changes } },
        { returnDocument: 'after' },
      ).lean(),
    );
  }

  async function finishSuccess(job: JobDocument): Promise<void> {
    const changes = job.recurring
      ? {
          status: 'pending',
          runAt: new Date(clock.now().getTime() + job.recurring.everyMs),
          attempts: 0,
          lastError: null,
        }
      : { status: 'done', lastError: null };
    await finish(job, changes);
  }

  async function reportFailure(job: JobDocument, message: string): Promise<void> {
    try {
      await inProperty(job, async () => {
        const id = job._id.toHexString();
        await recordAudit({
          action: 'job.failed',
          target: { type: 'background_job', id },
          summary: { type: job.type, attempts: job.attempts, error: message },
        });
        const managers = await managersOf(job.propertyId);
        await notifications.notify({
          recipientIds: managers,
          type: 'job_failed',
          title: `Background job failed: ${job.type}`,
          body: `${job.type} stopped after ${job.attempts} attempts. See the audit log for the error.`,
          link: { kind: 'job', id },
          dedupeKey: `job_failed:${id}:${clock.now().toISOString().slice(0, 10)}`,
        });
      });
    } catch (error) {
      logger.error({ err: error, jobId: job._id.toHexString() }, 'Could not report a failed job');
    }
  }

  async function finishFailure(job: JobDocument, error: unknown): Promise<void> {
    const message = describeError(error);
    const exhausted = job.attempts >= job.maxAttempts;
    const changes = exhausted
      ? { status: 'failed', lastError: message }
      : {
          status: 'pending',
          runAt: new Date(clock.now().getTime() + backoffMs(job.attempts)),
          lastError: message,
        };
    const updated = await finish(job, changes);
    logger.error(
      { jobId: job._id.toHexString(), type: job.type, attempt: job.attempts, exhausted },
      'Background job failed',
    );
    if (updated && exhausted) await reportFailure(job, message);
  }

  async function run(job: JobDocument): Promise<void> {
    if (job.attempts > job.maxAttempts) {
      // Every earlier run ended with the worker dying, so running it again would not help.
      await finishFailure(job, new Error('Gave up: the worker running this job kept stopping'));
      return;
    }
    const view: JobView = {
      id: job._id.toHexString(),
      type: job.type,
      propertyId: job.propertyId,
      payload: job.payload,
      attempt: job.attempts,
    };
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
      await inProperty(job, () => handler(view));
    } catch (error) {
      await finishFailure(job, error);
      return;
    }
    await finishSuccess(job);
  }

  async function tick(): Promise<number> {
    let ran = 0;
    while (ran < maxJobsPerTick && !stopping) {
      const job = await claim(clock.now());
      if (!job) break;
      ran += 1;
      try {
        await run(job);
      } catch (error) {
        // Could not even record the outcome. The lease will run out and the job runs again.
        logger.error({ err: error, jobId: job._id.toHexString() }, 'Could not finish a job');
      }
    }
    return ran;
  }

  function poll(): void {
    if (inFlight || stopping) return;
    inFlight = tick()
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Background job tick failed');
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return {
    tick,
    start() {
      if (timer) return;
      stopping = false;
      timer = setInterval(poll, pollMs);
      timer.unref();
      poll();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
