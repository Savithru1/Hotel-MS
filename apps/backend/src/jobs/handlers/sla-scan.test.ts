import { Types } from 'mongoose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { FoodOrder } from '../../modules/food-orders/food-order.model';
import { MaintenanceIssue } from '../../modules/maintenance/maintenance.model';
import { Notification } from '../../modules/notifications/notification.model';
import {
  createNotificationService,
  type NotificationService,
} from '../../modules/notifications/notification.service';
import { Room } from '../../modules/rooms/room.model';
import { seedDevelopmentData, type SeededProperty } from '../../modules/seed/seed';
import { ServiceRequest } from '../../modules/service-requests/service-request.model';
import { createEventBus } from '../../shared/events/event-bus';
import { runWithContext, runWithTenant } from '../../shared/request-context';
import type { JobView } from '../worker';
import { createSlaScanHandler } from './sla-scan';

useTestDatabase();

const NOW = new Date('2026-06-01T12:00:00Z');
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

let a: SeededProperty;
let b: SeededProperty;
let roomA: Types.ObjectId;
let roomB: Types.ObjectId;
let bookingId: Types.ObjectId;
const clock = { now: () => NOW };

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  const room = async (property: SeededProperty): Promise<Types.ObjectId> => {
    const found = await runWithTenant(property.id, () => Room.findOne({ number: '101' }).lean());
    if (!found) throw new Error('seed room missing');
    return found._id;
  };
  roomA = await room(a);
  roomB = await room(b);
  bookingId = new Types.ObjectId();
});

// Each test starts with nothing open, so only the items it plants can be reminded about.
beforeEach(async () => {
  for (const property of [a, b]) {
    await runWithTenant(property.id, async () => {
      await ServiceRequest.deleteMany({});
      await MaintenanceIssue.deleteMany({});
      await FoodOrder.deleteMany({});
      await Notification.deleteMany({});
    });
  }
});

function jobFor(property: SeededProperty): JobView {
  return {
    id: new Types.ObjectId().toHexString(),
    type: 'sla.scan',
    propertyId: property.id,
    payload: {},
    attempt: 1,
  };
}

/** Runs one scan the way the worker does: inside the property, as the system. */
function scan(
  property: SeededProperty,
  notifications: NotificationService = createNotificationService(createEventBus()),
): Promise<void> {
  const handler = createSlaScanHandler({ clock, notifications });
  return runWithContext(
    { propertyId: property.id, principal: { kind: 'system', id: 'system' } },
    () => handler(jobFor(property)),
  );
}

let code = 0;
const plantRequest = (
  property: SeededProperty,
  room: Types.ObjectId,
  ageMinutes: number,
  extra: Record<string, unknown> = {},
) =>
  runWithTenant(property.id, () =>
    ServiceRequest.create({
      type: 'room_cleaning',
      roomId: room,
      createdAt: minutesAgo(ageMinutes),
      ...extra,
    }),
  );

const plantIssue = (
  property: SeededProperty,
  room: Types.ObjectId,
  ageMinutes: number,
  extra: Record<string, unknown> = {},
) =>
  runWithTenant(property.id, () =>
    MaintenanceIssue.create({
      category: 'plumbing',
      description: 'Leak',
      roomId: room,
      createdAt: minutesAgo(ageMinutes),
      ...extra,
    }),
  );

const plantOrder = (
  property: SeededProperty,
  room: Types.ObjectId,
  ageMinutes: number,
  extra: Record<string, unknown> = {},
) =>
  runWithTenant(property.id, () =>
    FoodOrder.create({
      code: `SLA-${++code}`,
      roomId: room,
      roomNumber: '101',
      bookingId,
      guestName: 'Guest',
      items: [
        {
          menuItemId: new Types.ObjectId(),
          name: 'Tea',
          quantity: 1,
          unitPricePaise: 5000,
          lineTotalPaise: 5000,
        },
      ],
      subtotalPaise: 5000,
      createdAt: minutesAgo(ageMinutes),
      ...extra,
    }),
  );

const remindersFor = (property: SeededProperty, id: Types.ObjectId) =>
  runWithTenant(property.id, () =>
    Notification.find({ 'link.id': id.toHexString(), type: 'sla_breach' }).lean(),
  );
const managerCount = 2; // the seeded manager and property admin

describe('housekeeping', () => {
  it('reminds managers once about the request past its limit, not the one inside it', async () => {
    const recent = await plantRequest(a, roomA, 10);
    const overdue = await plantRequest(a, roomA, 40);

    await scan(a);

    expect(await remindersFor(a, recent._id)).toHaveLength(0);
    const sent = await remindersFor(a, overdue._id);
    expect(sent).toHaveLength(managerCount);
    expect(sent.map((n) => n.recipient.id.toHexString()).sort()).toEqual(
      [a.staff.manager?.id, a.staff.property_admin?.id].map((id) => id?.toHexString()).sort(),
    );
    expect(sent[0]).toMatchObject({
      type: 'sla_breach',
      link: { kind: 'housekeeping' },
      title: expect.stringContaining('101'),
    });
    const stored = await runWithTenant(a.id, () =>
      ServiceRequest.find({ _id: { $in: [recent._id, overdue._id] } }).lean(),
    );
    expect(stored.find((r) => r._id.equals(overdue._id))?.slaRemindedAt).toEqual(NOW);
    expect(stored.find((r) => r._id.equals(recent._id))?.slaRemindedAt).toBeNull();
  });

  it('sends nothing new when it runs again', async () => {
    const overdue = await plantRequest(a, roomA, 40);
    await scan(a);
    const before = await runWithTenant(a.id, () => Notification.countDocuments({}));
    await scan(a);
    await scan(a);
    expect(await runWithTenant(a.id, () => Notification.countDocuments({}))).toBe(before);
    expect(await remindersFor(a, overdue._id)).toHaveLength(managerCount);
  });

  it('sends one reminder, not five, when five scans run at once', async () => {
    const overdue = await plantRequest(a, roomA, 40);
    await Promise.all(Array.from({ length: 5 }, () => scan(a)));
    expect(await remindersFor(a, overdue._id)).toHaveLength(managerCount);
  });

  it('uses the shorter limit for urgent requests', async () => {
    const urgent = await plantRequest(a, roomA, 20, { priority: 'urgent', priorityRank: 1 });
    const normal = await plantRequest(a, roomA, 20);
    await scan(a);
    expect(await remindersFor(a, urgent._id)).toHaveLength(managerCount);
    expect(await remindersFor(a, normal._id)).toHaveLength(0);
  });

  it('keeps reminding about in-progress work, but never about finished or cancelled requests', async () => {
    const working = await plantRequest(a, roomA, 90, { status: 'in_progress' });
    const completed = await plantRequest(a, roomA, 90, { status: 'completed' });
    const cancelled = await plantRequest(a, roomA, 90, { status: 'cancelled' });
    await scan(a);
    expect(await remindersFor(a, working._id)).toHaveLength(managerCount);
    expect(await remindersFor(a, completed._id)).toHaveLength(0);
    expect(await remindersFor(a, cancelled._id)).toHaveLength(0);
  });

  it('does not remind about a request that was completed just before the scan', async () => {
    const overdue = await plantRequest(a, roomA, 40);
    await runWithTenant(a.id, () =>
      ServiceRequest.updateOne({ _id: overdue._id }, { status: 'completed' }),
    );
    await scan(a);
    expect(await remindersFor(a, overdue._id)).toHaveLength(0);
  });
});

describe('maintenance', () => {
  it.each([
    ['low', 239, false],
    ['low', 241, true],
    ['medium', 119, false],
    ['medium', 121, true],
    ['high', 59, false],
    ['high', 61, true],
    ['urgent', 29, false],
    ['urgent', 31, true],
  ])('%s priority at %i minutes: reminded = %s', async (priority, age, reminded) => {
    const issue = await plantIssue(a, roomA, age, { priority });
    await scan(a);
    expect(await remindersFor(a, issue._id)).toHaveLength(reminded ? managerCount : 0);
  });

  it('never reminds about resolved issues', async () => {
    const issue = await plantIssue(a, roomA, 1000, { status: 'resolved', priority: 'urgent' });
    await scan(a);
    expect(await remindersFor(a, issue._id)).toHaveLength(0);
  });

  it('counts assigned and in-progress issues as open', async () => {
    const assigned = await plantIssue(a, roomA, 100, { status: 'assigned', priority: 'high' });
    const working = await plantIssue(a, roomA, 100, { status: 'in_progress', priority: 'high' });
    await scan(a);
    expect(await remindersFor(a, assigned._id)).toHaveLength(managerCount);
    expect(await remindersFor(a, working._id)).toHaveLength(managerCount);
  });
});

describe('food orders', () => {
  it('reminds about open orders older than the late limit only', async () => {
    const fresh = await plantOrder(a, roomA, 10);
    const late = await plantOrder(a, roomA, 25);
    const ready = await plantOrder(a, roomA, 25, { status: 'ready' });
    const delivered = await plantOrder(a, roomA, 100, { status: 'delivered' });
    const cancelled = await plantOrder(a, roomA, 100, { status: 'cancelled' });
    await scan(a);
    expect(await remindersFor(a, fresh._id)).toHaveLength(0);
    expect(await remindersFor(a, late._id)).toHaveLength(managerCount);
    expect(await remindersFor(a, ready._id)).toHaveLength(managerCount);
    expect(await remindersFor(a, delivered._id)).toHaveLength(0);
    expect(await remindersFor(a, cancelled._id)).toHaveLength(0);
    expect((await remindersFor(a, late._id))[0]?.link.kind).toBe('food_order');
  });
});

describe('properties', () => {
  it('a scan for one property never touches or notifies another', async () => {
    const theirs = await plantRequest(b, roomB, 100);
    const mine = await plantRequest(a, roomA, 100);

    await scan(a);

    expect(await remindersFor(b, theirs._id)).toHaveLength(0);
    expect(
      (await runWithTenant(b.id, () => ServiceRequest.findOne({ _id: theirs._id }).lean()))
        ?.slaRemindedAt,
    ).toBeNull();
    expect(await runWithTenant(b.id, () => Notification.countDocuments({}))).toBe(0);
    expect(await remindersFor(a, mine._id)).toHaveLength(managerCount);

    await scan(b);
    const sent = await remindersFor(b, theirs._id);
    expect(sent).toHaveLength(managerCount);
    expect(sent.every((n) => n.propertyId.equals(b.id))).toBe(true);
  });
});

describe('when something goes wrong', () => {
  it('puts the reminder back so the next scan can try again', async () => {
    const overdue = await plantRequest(a, roomA, 40);
    const failing = {
      notify: () => Promise.reject(new Error('database down')),
    } as unknown as NotificationService;

    await expect(scan(a, failing)).rejects.toThrow('database down');
    expect(
      (await runWithTenant(a.id, () => ServiceRequest.findOne({ _id: overdue._id }).lean()))
        ?.slaRemindedAt,
    ).toBeNull();

    await scan(a);
    expect(await remindersFor(a, overdue._id)).toHaveLength(managerCount);
  });

  it('does not mark anything reminded when the property has no active manager', async () => {
    const overdue = await plantRequest(a, roomA, 40);
    const { Staff } = await import('../../modules/staff/staff.model');
    await runWithTenant(a.id, () =>
      Staff.updateMany({ role: { $in: ['manager', 'property_admin'] } }, { active: false }),
    );
    try {
      await scan(a);
      expect(
        (await runWithTenant(a.id, () => ServiceRequest.findOne({ _id: overdue._id }).lean()))
          ?.slaRemindedAt,
      ).toBeNull();
    } finally {
      await runWithTenant(a.id, () =>
        Staff.updateMany({ role: { $in: ['manager', 'property_admin'] } }, { active: true }),
      );
    }
  });
});
