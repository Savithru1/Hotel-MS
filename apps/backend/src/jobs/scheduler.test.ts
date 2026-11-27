import { pino } from 'pino';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../test/db';
import { Property } from '../modules/properties/property.model';
import { createEventBus } from '../shared/events/event-bus';
import { createNotificationService } from '../modules/notifications/notification.service';
import { seedDevelopmentData, type SeededProperty } from '../modules/seed/seed';
import { runAsPlatform, runWithTenant } from '../shared/request-context';
import { BackgroundJob } from './job.model';
import { createScheduler, RECURRING_JOBS } from './scheduler';
import { createWorker, type Clock } from './worker';

useTestDatabase();

const NOW = new Date('2026-06-01T10:00:00Z');
const clock: Clock = { now: () => NOW };
const logger = pino({ level: 'silent' });

let a: SeededProperty;
let b: SeededProperty;
let closedId: string;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  const closed = await runAsPlatform(() =>
    Property.create({ name: 'Closed Hotel', slug: 'closed-hotel', active: false }),
  );
  closedId = closed._id.toHexString();
});

beforeEach(async () => {
  await runAsPlatform(() => BackgroundJob.deleteMany({}));
});

const jobsOf = (property: SeededProperty) =>
  runWithTenant(property.id, () => BackgroundJob.find({}).sort({ type: 1 }).lean());

describe('scheduler.ensure', () => {
  it('registers the recurring jobs once for every active property', async () => {
    const created = await createScheduler({ clock, logger }).ensure();
    expect(created).toBe(RECURRING_JOBS.length * 2);

    for (const property of [a, b]) {
      const jobs = await jobsOf(property);
      expect(jobs.map((job) => job.type)).toEqual(['notifications.cleanup', 'sla.scan']);
      const scan = jobs.find((job) => job.type === 'sla.scan');
      expect(scan).toMatchObject({
        status: 'pending',
        attempts: 0,
        recurring: { everyMs: 60_000 },
      });
      expect(scan?.runAt).toEqual(NOW);
      expect(jobs.find((job) => job.type === 'notifications.cleanup')?.recurring).toEqual({
        everyMs: 24 * 3_600_000,
      });
    }
  });

  it('leaves inactive properties alone', async () => {
    await createScheduler({ clock, logger }).ensure();
    const count = await runAsPlatform(() => BackgroundJob.countDocuments({ propertyId: closedId }));
    expect(count).toBe(0);
  });

  it('is safe to run again and at the same time: still one copy of each job', async () => {
    const scheduler = createScheduler({ clock, logger });
    await Promise.all([scheduler.ensure(), scheduler.ensure(), scheduler.ensure()]);
    await scheduler.ensure();
    expect(await jobsOf(a)).toHaveLength(RECURRING_JOBS.length);
    expect(await jobsOf(b)).toHaveLength(RECURRING_JOBS.length);
    expect(await scheduler.ensure()).toBe(0);
  });

  it('does not disturb a job that is already scheduled or running', async () => {
    const scheduler = createScheduler({ clock, logger });
    await scheduler.ensure();
    const later = new Date(NOW.getTime() + 45_000);
    await runWithTenant(a.id, () =>
      BackgroundJob.updateOne(
        { type: 'sla.scan' },
        { runAt: later, status: 'running', attempts: 1 },
      ),
    );
    await scheduler.ensure();
    const scan = (await jobsOf(a)).find((job) => job.type === 'sla.scan');
    expect(scan).toMatchObject({ status: 'running', attempts: 1 });
    expect(scan?.runAt).toEqual(later);
  });

  it('puts a recurring job that gave up back in the queue', async () => {
    const scheduler = createScheduler({ clock, logger });
    await scheduler.ensure();
    await runWithTenant(a.id, () =>
      BackgroundJob.updateOne({ type: 'sla.scan' }, { status: 'failed', attempts: 5 }),
    );
    await scheduler.ensure();
    const scan = (await jobsOf(a)).find((job) => job.type === 'sla.scan');
    expect(scan).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('does not revive a one-off job that failed', async () => {
    await runWithTenant(a.id, () =>
      BackgroundJob.create({
        type: 'sla.scan',
        dedupeKey: 'oneoff',
        runAt: NOW,
        status: 'failed',
        attempts: 5,
      }),
    );
    await createScheduler({ clock, logger }).ensure();
    const oneOff = (await jobsOf(a)).find((job) => job.dedupeKey === 'oneoff');
    expect(oneOff?.status).toBe('failed');
  });
});

describe('scheduler and worker together', () => {
  it('run the scan and the cleanup for each property, then schedule the next run', async () => {
    await createScheduler({ clock, logger }).ensure();
    const ran: string[] = [];
    const worker = createWorker({
      clock,
      pollMs: 20,
      logger,
      notifications: createNotificationService(createEventBus()),
      handlers: {
        'sla.scan': async (job) => void ran.push(`scan:${job.propertyId.toHexString()}`),
        'notifications.cleanup': async (job) =>
          void ran.push(`cleanup:${job.propertyId.toHexString()}`),
      },
    });
    expect(await worker.tick()).toBe(4);
    expect(ran.sort()).toEqual(
      [
        `scan:${a.id.toHexString()}`,
        `scan:${b.id.toHexString()}`,
        `cleanup:${a.id.toHexString()}`,
        `cleanup:${b.id.toHexString()}`,
      ].sort(),
    );
    const next = (await jobsOf(a)).find((job) => job.type === 'sla.scan');
    expect(next?.runAt.getTime()).toBe(NOW.getTime() + 60_000);
    expect(await worker.tick()).toBe(0);
  });
});

describe('scheduler start and stop', () => {
  it('ensures the jobs when started and stops cleanly', async () => {
    const scheduler = createScheduler({ clock, logger, refreshMs: 50 });
    scheduler.start();
    const deadline = Date.now() + 5000;
    while ((await jobsOf(a)).length < RECURRING_JOBS.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await scheduler.stop();
    expect(await jobsOf(a)).toHaveLength(RECURRING_JOBS.length);
  });
});
