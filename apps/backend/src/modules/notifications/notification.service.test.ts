import { NOTIFICATION_READ_RETENTION_DAYS } from '@hospitality/constants';
import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { createEventBus, type DomainEvent } from '../../shared/events/event-bus';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { managersOf } from './managers';
import { Notification } from './notification.model';
import { createNotificationService, type NotifyInput } from './notification.service';

useTestDatabase();

const DAY_MS = 86_400_000;
let a: SeededProperty;
let b: SeededProperty;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

type Role = 'manager' | 'housekeeping' | 'front_desk' | 'property_admin';

const idOf = (property: SeededProperty, role: Role): Types.ObjectId => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return staff.id;
};

function setup() {
  const bus = createEventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((event) => events.push(event));
  return { service: createNotificationService(bus), events };
}

let counter = 0;
const input = (recipients: Types.ObjectId[], extra: Partial<NotifyInput> = {}): NotifyInput => ({
  recipientIds: recipients.map((id) => id.toHexString()),
  type: 'escalation',
  title: 'Room 101 escalated',
  body: 'Something needs a manager',
  link: { kind: 'housekeeping', id: new Types.ObjectId().toHexString() },
  dedupeKey: `test:${++counter}`,
  ...extra,
});

const inA = <T>(fn: () => T): T => runWithTenant(a.id, fn);

describe('notify', () => {
  it('stores one unread notification for each person', async () => {
    const { service } = setup();
    const people = [idOf(a, 'manager'), idOf(a, 'front_desk')];
    const key = input(people);
    const created = await inA(() => service.notify(key));

    expect(created.map(String).sort()).toEqual(people.map(String).sort());
    const stored = await inA(() => Notification.find({ dedupeKey: key.dedupeKey }).lean());
    expect(stored).toHaveLength(2);
    expect(stored.every((n) => n.readAt === null && n.expireAt === null)).toBe(true);
    expect(stored.every((n) => n.propertyId.equals(a.id))).toBe(true);
  });

  it('does not store a second copy when the same event is notified twice', async () => {
    const { service, events } = setup();
    const manager = idOf(a, 'manager');
    const once = input([manager]);

    const first = await inA(() => service.notify(once));
    const second = await inA(() => service.notify(once));

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(await inA(() => Notification.countDocuments({ dedupeKey: once.dedupeKey }))).toBe(1);
    // Only the first call announced anything live.
    expect(events).toHaveLength(1);
  });

  it('notifies only the people who have not had it yet when the group overlaps', async () => {
    const { service } = setup();
    const manager = idOf(a, 'manager');
    const desk = idOf(a, 'front_desk');
    const key = input([manager]);
    await inA(() => service.notify(key));
    const created = await inA(() =>
      service.notify({ ...key, recipientIds: [manager.toHexString(), desk.toHexString()] }),
    );
    expect(created.map(String)).toEqual([String(desk)]);
  });

  it('treats a different dedupe key as a new notification', async () => {
    const { service } = setup();
    const manager = idOf(a, 'manager');
    const first = input([manager]);
    await inA(() => service.notify(first));
    const again = await inA(() => service.notify({ ...first, dedupeKey: `${first.dedupeKey}-2` }));
    expect(again).toHaveLength(1);
  });

  it('announces live to exactly the people it was stored for, and nobody else', async () => {
    const { service, events } = setup();
    const manager = idOf(a, 'manager');
    await inA(() => service.notify(input([manager], { type: 'sla_breach' })));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'notification.created',
      audience: { managers: false, staffIds: [manager.toHexString()] },
      data: { type: 'sla_breach', linkKind: 'housekeeping' },
    });
    expect(String(events[0]?.propertyId)).toBe(a.id.toHexString());
  });

  it('shortens a title and body that are too long instead of failing', async () => {
    const { service } = setup();
    const manager = idOf(a, 'manager');
    const long = input([manager], { title: 'T'.repeat(500), body: 'B'.repeat(900) });
    await inA(() => service.notify(long));
    const stored = await inA(() => Notification.findOne({ dedupeKey: long.dedupeKey }).lean());
    expect(stored?.title).toHaveLength(120);
    expect(stored?.body).toHaveLength(300);
  });

  it('does nothing for an empty list of recipients', async () => {
    const { service, events } = setup();
    expect(await inA(() => service.notify(input([])))).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('refuses to run without a property', async () => {
    const { service } = setup();
    await expect(service.notify(input([idOf(a, 'manager')]))).rejects.toThrow();
  });
});

describe('indexes', () => {
  it('has a TTL index on expireAt and a unique dedupe index', async () => {
    await Notification.init();
    const indexes = await Notification.listIndexes();
    const ttl = indexes.find((i) => (i.key as Record<string, number>).expireAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(0);
    const unique = indexes.find((i) => i.unique && 'dedupeKey' in (i.key as object));
    expect(Object.keys(unique?.key as object)).toEqual(['propertyId', 'recipient.id', 'dedupeKey']);
  });
});

describe('reading', () => {
  it('lists only my notifications, newest first, with an unread filter', async () => {
    const { service } = setup();
    const me = idOf(a, 'front_desk');
    const other = idOf(a, 'housekeeping');
    await inA(() => service.notify(input([me], { title: 'older' })));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await inA(() => service.notify(input([me], { title: 'newer' })));
    await inA(() => service.notify(input([other], { title: 'not mine' })));

    const all = await inA(() => service.listForStaff(me, { page: 1, limit: 50 }));
    const titles = all.items.map((n) => n.title);
    expect(titles).not.toContain('not mine');
    expect(titles.indexOf('newer')).toBeLessThan(titles.indexOf('older'));

    const first = all.items[0];
    if (!first) throw new Error('expected a notification');
    await inA(() => service.markRead(me, first.id));
    const unread = await inA(() => service.listForStaff(me, { page: 1, limit: 50, unread: true }));
    expect(unread.items.map((n) => n.id)).not.toContain(first.id);
    const read = await inA(() => service.listForStaff(me, { page: 1, limit: 50, unread: false }));
    expect(read.items.map((n) => n.id)).toEqual([first.id]);
  });

  it('pages the list', async () => {
    const { service } = setup();
    const me = idOf(a, 'front_desk');
    const page1 = await inA(() => service.listForStaff(me, { page: 1, limit: 1 }));
    const page2 = await inA(() => service.listForStaff(me, { page: 2, limit: 1 }));
    expect(page1.items).toHaveLength(1);
    expect(page2.items).toHaveLength(1);
    expect(page1.items[0]?.id).not.toBe(page2.items[0]?.id);
    expect(page1.total).toBeGreaterThanOrEqual(2);
  });

  it('counts unread notifications for one person', async () => {
    const { service } = setup();
    const me = idOf(a, 'housekeeping');
    const before = await inA(() => service.unreadCount(me));
    await inA(() => service.notify(input([me])));
    await inA(() => service.notify(input([me])));
    expect(await inA(() => service.unreadCount(me))).toBe(before + 2);
  });
});

describe('markRead', () => {
  async function plantFor(
    service: ReturnType<typeof setup>['service'],
    owner: Types.ObjectId,
  ): Promise<string> {
    const key = input([owner]);
    await inA(() => service.notify(key));
    const stored = await inA(() => Notification.findOne({ dedupeKey: key.dedupeKey }).lean());
    if (!stored) throw new Error('missing');
    return stored._id.toHexString();
  }

  it('sets readAt and schedules removal 30 days later', async () => {
    const { service } = setup();
    const me = idOf(a, 'manager');
    const id = await plantFor(service, me);

    const dto = await inA(() => service.markRead(me, id));
    expect(dto.readAt).not.toBeNull();

    const after = await inA(() => Notification.findOne({ _id: id }).lean());
    expect(after?.readAt).toBeInstanceOf(Date);
    expect(after?.expireAt?.getTime()).toBe(
      (after?.readAt?.getTime() ?? 0) + NOTIFICATION_READ_RETENTION_DAYS * DAY_MS,
    );
  });

  it('is harmless to repeat and keeps the first read time', async () => {
    const { service } = setup();
    const me = idOf(a, 'manager');
    const id = await plantFor(service, me);
    const first = await inA(() => service.markRead(me, id));
    const second = await inA(() => service.markRead(me, id));
    expect(second.readAt).toBe(first.readAt);
  });

  it("answers 404 for someone else's notification and leaves it unread", async () => {
    const { service } = setup();
    const id = await plantFor(service, idOf(a, 'manager'));

    await expect(inA(() => service.markRead(idOf(a, 'front_desk'), id))).rejects.toMatchObject({
      status: 404,
    });
    const after = await inA(() => Notification.findOne({ _id: id }).lean());
    expect(after?.readAt).toBeNull();
  });

  it('answers 404 for an id that does not exist', async () => {
    const { service } = setup();
    await expect(
      inA(() => service.markRead(idOf(a, 'manager'), new Types.ObjectId().toHexString())),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('reads all of mine and nobody else', async () => {
    const { service } = setup();
    const me = idOf(a, 'front_desk');
    const other = idOf(a, 'manager');
    await inA(() => service.notify(input([me, other])));
    await inA(() => service.notify(input([me, other])));

    const updated = await inA(() => service.markAllRead(me));
    expect(updated).toBeGreaterThanOrEqual(2);
    expect(await inA(() => service.unreadCount(me))).toBe(0);
    expect(await inA(() => service.unreadCount(other))).toBeGreaterThanOrEqual(2);
    expect(await inA(() => service.markAllRead(me))).toBe(0);
  });
});

describe('purgeOld', () => {
  const now = new Date('2026-06-30T00:00:00Z');
  const at = (days: number): Date => new Date(now.getTime() - days * DAY_MS);

  async function plant(
    property: SeededProperty,
    me: Types.ObjectId,
    ageDays: number,
    read: boolean,
  ): Promise<string> {
    const created = await runWithTenant(property.id, () =>
      Notification.create({
        recipient: { kind: 'staff', id: me },
        type: 'escalation',
        title: `aged ${ageDays}`,
        body: 'x',
        link: { kind: 'housekeeping', id: new Types.ObjectId().toHexString() },
        dedupeKey: `purge:${++counter}`,
        readAt: read ? at(ageDays) : null,
        createdAt: at(ageDays),
      }),
    );
    return created._id.toHexString();
  }

  it('removes unread items older than 90 days and keeps newer ones', async () => {
    const { service } = setup();
    const me = idOf(a, 'manager');
    const old = await plant(a, me, 91, false);
    const edge = await plant(a, me, 89, false);
    const readOld = await plant(a, me, 120, true);

    const removed = await inA(() => service.purgeOld(now));
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await inA(() => Notification.exists({ _id: old }))).toBeNull();
    expect(await inA(() => Notification.exists({ _id: edge }))).not.toBeNull();
    // Read items are removed by their own TTL, not by this cleanup.
    expect(await inA(() => Notification.exists({ _id: readOld }))).not.toBeNull();
  });

  it('only touches the current property', async () => {
    const { service } = setup();
    const old = await plant(b, idOf(b, 'manager'), 200, false);
    await inA(() => service.purgeOld(now));
    expect(await runWithTenant(b.id, () => Notification.exists({ _id: old }))).not.toBeNull();
  });
});

describe('managersOf', () => {
  it('returns the active managers and property admins of that property only', async () => {
    const ids = (await managersOf(a.id)).map(String).sort();
    expect(ids).toEqual([idOf(a, 'manager'), idOf(a, 'property_admin')].map(String).sort());
    expect(ids).not.toContain(String(idOf(b, 'manager')));
    expect(ids).not.toContain(String(idOf(a, 'front_desk')));
  });
});
