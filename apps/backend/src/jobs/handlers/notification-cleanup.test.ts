import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { Notification } from '../../modules/notifications/notification.model';
import { createNotificationService } from '../../modules/notifications/notification.service';
import { seedDevelopmentData, type SeededProperty } from '../../modules/seed/seed';
import { createEventBus } from '../../shared/events/event-bus';
import { runWithContext, runWithTenant } from '../../shared/request-context';
import { createNotificationCleanupHandler } from './notification-cleanup';

useTestDatabase();

const NOW = new Date('2026-06-30T00:00:00Z');
const DAY_MS = 86_400_000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
let a: SeededProperty;
let b: SeededProperty;
let counter = 0;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

const plant = (property: SeededProperty, ageDays: number) =>
  runWithTenant(property.id, () =>
    Notification.create({
      recipient: { kind: 'staff', id: property.staff.manager?.id },
      type: 'escalation',
      title: `aged ${ageDays}`,
      body: 'x',
      link: { kind: 'housekeeping', id: new Types.ObjectId().toHexString() },
      dedupeKey: `cleanup:${++counter}`,
      createdAt: daysAgo(ageDays),
    }),
  );

describe('notification cleanup job', () => {
  it('removes unread notifications older than 90 days in its own property only', async () => {
    const old = await plant(a, 100);
    const recent = await plant(a, 10);
    const otherOld = await plant(b, 100);

    const handler = createNotificationCleanupHandler({
      clock: { now: () => NOW },
      notifications: createNotificationService(createEventBus()),
    });
    await runWithContext({ propertyId: a.id, principal: { kind: 'system', id: 'system' } }, () =>
      handler({
        id: new Types.ObjectId().toHexString(),
        type: 'notifications.cleanup',
        propertyId: a.id,
        payload: {},
        attempt: 1,
      }),
    );

    expect(await runWithTenant(a.id, () => Notification.exists({ _id: old._id }))).toBeNull();
    expect(
      await runWithTenant(a.id, () => Notification.exists({ _id: recent._id })),
    ).not.toBeNull();
    expect(
      await runWithTenant(b.id, () => Notification.exists({ _id: otherOld._id })),
    ).not.toBeNull();
  });
});
