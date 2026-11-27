import {
  JOB_BACKOFF_BASE_MS,
  JOB_LEASE_MS,
  JOB_MAX_ATTEMPTS,
  type JobType,
} from '@hospitality/constants';
import { Types } from 'mongoose';
import { pino } from 'pino';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../test/db';
import { AuditLog } from '../shared/audit/audit-log.model';
import { createEventBus } from '../shared/events/event-bus';
import { getContext, getTenantId, runAsPlatform, runWithTenant } from '../shared/request-context';
import { createNotificationService } from '../modules/notifications/notification.service';
import { Notification } from '../modules/notifications/notification.model';
import { seedDevelopmentData, type SeededProperty } from '../modules/seed/seed';
import { ServiceRequest } from '../modules/service-requests/service-request.model';
import { BackgroundJob, type JobDocument } from './job.model';
import { createWorker, type Clock, type JobHandler, type Worker } from './worker';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

// Every test starts with an empty job table, so leftovers cannot be picked up by a later test.
beforeEach(async () => {
  await runAsPlatform(() => BackgroundJob.deleteMany({}));
});

const START = new Date('2026-06-01T10:00:00Z');

function fakeClock(): Clock & { set(date: Date): void; advance(ms: number): void } {
  let current = START;
  return {
    now: () => current,
    set: (date) => {
      current = date;
    },
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

const silent = pino({ level: 'silent' });
const notifications = createNotificationService(createEventBus());

function workerWith(clock: Clock, handlers: Partial<Record<JobType, JobHandler>>): Worker {
  return createWorker({ clock, pollMs: 20, handlers, logger: silent, notifications });
}

let counter = 0;
interface Enqueue {
  property?: SeededProperty;
  type?: JobType;
  runAt?: Date;
  recurringMs?: number;
  maxAttempts?: number;
  status?: JobDocument['status'];
  lockedUntil?: Date | null;
  attempts?: number;
  payload?: Record<string, unknown>;
}

async function enqueue(options: Enqueue = {}): Promise<string> {
  const property = options.property ?? a;
  const created = await runWithTenant(property.id, () =>
    BackgroundJob.create({
      type: options.type ?? 'sla.scan',
      dedupeKey: `test:${++counter}`,
      runAt: options.runAt ?? START,
      status: options.status ?? 'pending',
      attempts: options.attempts ?? 0,
      lockedUntil: options.lockedUntil ?? null,
      lockToken: options.status === 'running' ? 'old-token' : null,
      payload: options.payload ?? {},
      ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.recurringMs ? { recurring: { everyMs: options.recurringMs } } : {}),
    }),
  );
  return created._id.toHexString();
}

const load = (id: string) => runAsPlatform(() => BackgroundJob.findOne({ _id: id }).lean());
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('claiming', () => {
  it('runs each of 10 jobs exactly once when 5 workers tick at the same time', async () => {
    const clock = fakeClock();
    const jobIds = await Promise.all(Array.from({ length: 10 }, () => enqueue()));
    const seen: string[] = [];
    let counted = 0;
    const handler: JobHandler = async (job) => {
      await sleep(5);
      counted += 1;
      seen.push(job.id);
    };
    const workers = Array.from({ length: 5 }, () => workerWith(clock, { 'sla.scan': handler }));

    await Promise.all(workers.map((worker) => worker.tick()));

    expect(counted).toBe(10);
    expect(new Set(seen).size).toBe(10);
    expect([...seen].sort()).toEqual([...jobIds].sort());
    for (const id of jobIds) {
      expect(await load(id)).toMatchObject({ status: 'done', attempts: 1, lockToken: null });
    }
  });

  it('does not run a job before it is due', async () => {
    const clock = fakeClock();
    const id = await enqueue({ runAt: new Date(START.getTime() + 60_000) });
    let ran = 0;
    const worker = workerWith(clock, { 'sla.scan': async () => void (ran += 1) });
    await worker.tick();
    expect(ran).toBe(0);
    clock.advance(60_000);
    await worker.tick();
    expect(ran).toBe(1);
    expect((await load(id))?.status).toBe('done');
  });

  it('does not run a finished job again', async () => {
    const clock = fakeClock();
    await enqueue();
    let ran = 0;
    const worker = workerWith(clock, { 'sla.scan': async () => void (ran += 1) });
    await worker.tick();
    const first = ran;
    await worker.tick();
    clock.advance(10 * 60_000);
    await worker.tick();
    expect(ran).toBe(first);
  });
});

describe('recurring jobs', () => {
  it('are rescheduled as the same document, not duplicated', async () => {
    const clock = fakeClock();
    const id = await enqueue({ recurringMs: 60_000 });
    let ran = 0;
    const worker = workerWith(clock, { 'sla.scan': async () => void (ran += 1) });

    await worker.tick();
    expect(ran).toBe(1);
    const after = await load(id);
    expect(after).toMatchObject({
      status: 'pending',
      attempts: 0,
      lockToken: null,
      lastError: null,
    });
    expect(after?.runAt.getTime()).toBe(START.getTime() + 60_000);
    expect(await runAsPlatform(() => BackgroundJob.countDocuments({ _id: id }))).toBe(1);

    await worker.tick(); // not due yet
    expect(ran).toBe(1);
    clock.advance(60_000);
    await worker.tick();
    expect(ran).toBe(2);
    expect((await load(id))?.runAt.getTime()).toBe(START.getTime() + 120_000);
  });
});

describe('failures', () => {
  it('retries with exponential backoff, then marks the job failed, audits and tells managers', async () => {
    const clock = fakeClock();
    const id = await enqueue();
    let ran = 0;
    const longMessage = 'x'.repeat(600);
    const worker = workerWith(clock, {
      'sla.scan': async () => {
        ran += 1;
        throw new Error(longMessage);
      },
    });

    const expectedDelays = [30, 60, 120, 240].map((seconds) => seconds * 1000);
    expect(expectedDelays[0]).toBe(JOB_BACKOFF_BASE_MS);
    for (const [index, delay] of expectedDelays.entries()) {
      await worker.tick();
      expect(ran).toBe(index + 1);
      const doc = await load(id);
      expect(doc?.status).toBe('pending');
      expect(doc?.attempts).toBe(index + 1);
      expect(doc?.runAt.getTime()).toBe(clock.now().getTime() + delay);
      // Not yet due: another tick does nothing.
      await worker.tick();
      expect(ran).toBe(index + 1);
      clock.advance(delay);
    }

    await worker.tick();
    expect(ran).toBe(JOB_MAX_ATTEMPTS);
    const failed = await load(id);
    expect(failed?.status).toBe('failed');
    expect(failed?.lockToken).toBeNull();
    expect(failed?.lastError).toHaveLength(500);
    expect(failed?.lastError).not.toMatch(/\n\s+at /);

    // It never runs again.
    clock.advance(24 * 3_600_000);
    await worker.tick();
    expect(ran).toBe(JOB_MAX_ATTEMPTS);

    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'job.failed', 'target.id': id }).lean(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toMatchObject({ kind: 'system' });
    const told = await runWithTenant(a.id, () => Notification.find({ 'link.id': id }).lean());
    expect(told.map((n) => n.recipient.id.toHexString()).sort()).toEqual(
      [a.staff.manager?.id, a.staff.property_admin?.id].map((x) => x?.toHexString()).sort(),
    );
    expect(told[0]).toMatchObject({ type: 'job_failed', link: { kind: 'job' } });
  });

  it('caps the delay at 30 minutes', async () => {
    const clock = fakeClock();
    const id = await enqueue({ maxAttempts: 20, attempts: 9 });
    const worker = workerWith(clock, {
      'sla.scan': async () => {
        throw new Error('still broken');
      },
    });
    await worker.tick();
    expect((await load(id))?.runAt.getTime()).toBe(clock.now().getTime() + 30 * 60_000);
  });

  it('fails a job whose type has no handler instead of leaving it stuck', async () => {
    const clock = fakeClock();
    const id = await enqueue({ type: 'billing.sync_open', maxAttempts: 1 });
    await workerWith(clock, {}).tick();
    const doc = await load(id);
    expect(doc?.status).toBe('failed');
    expect(doc?.lastError).toMatch(/No handler/);
  });

  it('keeps ticking after one job throws', async () => {
    const clock = fakeClock();
    const bad = await enqueue({ payload: { bad: true } });
    const good = await enqueue();
    const worker = workerWith(clock, {
      'sla.scan': async (job) => {
        if (job.payload.bad) throw new Error('boom');
      },
    });
    await worker.tick();
    expect((await load(bad))?.status).toBe('pending');
    expect((await load(good))?.status).toBe('done');
  });
});

describe('crashed and slow workers', () => {
  it('picks up a job whose lease ran out, and leaves one that is still leased alone', async () => {
    const clock = fakeClock();
    const stale = await enqueue({
      status: 'running',
      attempts: 1,
      lockedUntil: new Date(START.getTime() - 1000),
    });
    const live = await enqueue({
      status: 'running',
      attempts: 1,
      lockedUntil: new Date(START.getTime() + 30_000),
    });
    const ran: string[] = [];
    const worker = workerWith(clock, { 'sla.scan': async (job) => void ran.push(job.id) });

    await worker.tick();
    expect(ran).toEqual([stale]);
    expect(await load(stale)).toMatchObject({ status: 'done', attempts: 2, lockToken: null });
    expect((await load(live))?.status).toBe('running');

    clock.advance(31_000);
    await worker.tick();
    expect(ran).toEqual([stale, live]);
  });

  it('gives up on a job that keeps crashing its workers', async () => {
    const clock = fakeClock();
    const id = await enqueue({
      status: 'running',
      attempts: JOB_MAX_ATTEMPTS,
      lockedUntil: new Date(START.getTime() - 1000),
    });
    let ran = 0;
    await workerWith(clock, { 'sla.scan': async () => void (ran += 1) }).tick();
    expect(ran).toBe(0);
    expect(await load(id)).toMatchObject({ status: 'failed' });
  });

  it('ignores a late finish from a worker whose lease was taken over', async () => {
    const clock = fakeClock();
    const id = await enqueue();
    let release: (error?: Error) => void = () => undefined;
    const slow = new Promise<void>((resolve, reject) => {
      release = (error) => (error ? reject(error) : resolve());
    });
    let calls = 0;
    const handler: JobHandler = async () => {
      calls += 1;
      if (calls === 1) await slow; // the first worker hangs
    };
    const first = workerWith(clock, { 'sla.scan': handler });
    const second = workerWith(clock, { 'sla.scan': handler });

    const firstTick = first.tick();
    await sleep(100); // the first worker has claimed the job and is stuck in the handler
    expect((await load(id))?.status).toBe('running');

    clock.advance(JOB_LEASE_MS + 1000);
    await second.tick(); // takes over the expired lease and finishes properly
    const finished = await load(id);
    expect(finished?.status).toBe('done');
    expect(calls).toBe(2);

    release(new Error('too late, and failing')); // the stale worker now fails
    await firstTick;

    const after = await load(id);
    expect(after).toMatchObject({ status: 'done', lastError: null, lockToken: null });
    expect(after?.attempts).toBe(finished?.attempts);
    expect(after?.lastFinishedAt?.getTime()).toBe(finished?.lastFinishedAt?.getTime());
    expect(await runWithTenant(a.id, () => AuditLog.countDocuments({ 'target.id': id }))).toBe(0);
  });
});

describe('running inside the right property', () => {
  it('runs the handler as the job’s property with a system principal', async () => {
    const clock = fakeClock();
    const jobA = await enqueue({ property: a });
    const jobB = await enqueue({ property: b });
    const seen = new Map<string, { tenant?: string; principal?: unknown }>();
    const worker = workerWith(clock, {
      'sla.scan': async (job) => {
        seen.set(job.id, {
          tenant: getTenantId()?.toHexString(),
          principal: getContext()?.principal,
        });
        expect(getContext()?.platform).toBeUndefined();
      },
    });
    await worker.tick();

    expect(seen.get(jobA)?.tenant).toBe(a.id.toHexString());
    expect(seen.get(jobB)?.tenant).toBe(b.id.toHexString());
    expect(seen.get(jobA)?.principal).toEqual({ kind: 'system', id: 'system' });
  });

  it('cannot read another property’s documents from inside a job', async () => {
    const clock = fakeClock();
    const plant = (property: SeededProperty) =>
      runWithTenant(property.id, () =>
        ServiceRequest.create({
          type: 'room_cleaning',
          roomId: new Types.ObjectId(),
          notes: `request in ${property.slug}`,
        }),
      );
    const requestA = await plant(a);
    const requestB = await plant(b);

    const jobB = await enqueue({ property: b });
    const visible: string[] = [];
    const worker = workerWith(clock, {
      'sla.scan': async () => {
        const found = await ServiceRequest.find({}).lean();
        visible.push(...found.map((request) => request._id.toHexString()));
        // Asking for property A's document by id from property B's job finds nothing.
        expect(await ServiceRequest.findOne({ _id: requestA._id }).lean()).toBeNull();
      },
    });
    await worker.tick();

    expect(visible).toContain(requestB._id.toHexString());
    expect(visible).not.toContain(requestA._id.toHexString());
    expect((await load(jobB))?.status).toBe('done');
  });
});

describe('start and stop', () => {
  it('polls on its own, never overlaps its own ticks, and stops cleanly', async () => {
    const worker = workerWith(
      { now: () => new Date() },
      {
        'sla.scan': async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(80);
          active -= 1;
          done += 1;
        },
      },
    );
    let active = 0;
    let peak = 0;
    let done = 0;
    await enqueue({ runAt: new Date(0) });
    await enqueue({ runAt: new Date(0) });

    worker.start();
    const deadline = Date.now() + 5000;
    while (done < 2 && Date.now() < deadline) await sleep(20);
    await worker.stop();

    expect(done).toBe(2);
    expect(peak).toBe(1);
    await enqueue({ runAt: new Date(0) });
    await sleep(100);
    expect(done).toBe(2);
  });

  it('waits for the job in flight when stopping', async () => {
    let finished = false;
    const worker = workerWith(
      { now: () => new Date() },
      {
        'sla.scan': async () => {
          await sleep(150);
          finished = true;
        },
      },
    );
    await enqueue({ runAt: new Date(0) });
    worker.start();
    await sleep(60);
    await worker.stop();
    expect(finished).toBe(true);
  });
});
