import { Types } from 'mongoose';
import { pino } from 'pino';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { checkInGuest, lookup, day, today, type Lookup } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { plantBooking } from '../../../test/manager';
import { Bill } from '../../modules/billing/bill.model';
import { createBillingService } from '../../modules/billing/billing.service';
import { Booking } from '../../modules/bookings/booking.model';
import { FoodOrder } from '../../modules/food-orders/food-order.model';
import { createPropertyService } from '../../modules/properties/property.service';
import { seedDevelopmentData, type SeededProperty } from '../../modules/seed/seed';
import { runWithContext, runWithTenant } from '../../shared/request-context';
import type { JobView } from '../worker';
import { createBillingSyncHandler } from './billing-sync';

useTestDatabase();

const t = buildTestApp();
const billing = createBillingService(createPropertyService());
let a: SeededProperty;
let b: SeededProperty;
let ids: Lookup;
let desk: Client;
let phone = 0;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  desk = await t.actAs(a.staff.front_desk!.id, a.id);
  ids = await lookup(desk);
});

const inA = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(a.id, fn);
const nextPhone = (): string => `+9198765${String(++phone).padStart(5, '0')}`;

const billOf = (bookingId: string) =>
  inA(() => Bill.findOne({ bookingId: new Types.ObjectId(bookingId) }).lean());
const keysOf = (bill: { lines: { sourceKey: string }[] } | null): string[] =>
  (bill?.lines ?? []).map((line) => line.sourceKey).sort();

function jobFor(property: SeededProperty): JobView {
  return {
    id: new Types.ObjectId().toHexString(),
    type: 'billing.sync_open',
    propertyId: property.id,
    payload: {},
    attempt: 1,
  };
}

function runHandler(
  property: SeededProperty,
  logger: { error: (...args: unknown[]) => void } = pino({ level: 'silent' }),
): Promise<void> {
  const handler = createBillingSyncHandler({ billing, logger });
  return runWithContext(
    { propertyId: property.id, principal: { kind: 'system', id: 'system' } },
    () => handler(jobFor(property)),
  );
}

describe('billing.syncOpenBills', () => {
  it('opens the bill of a checked-in guest and posts the nights, once, however often it runs', async () => {
    const { bookingId } = await checkInGuest(desk, ids, '101', 'Standard', nextPhone());
    expect(await billOf(bookingId)).toBeNull();

    const first = await inA(() => billing.syncOpenBills());
    expect(first).toMatchObject({ synced: 1, failures: [] });
    const bill = await billOf(bookingId);
    expect(keysOf(bill)).toEqual([`room:${today()}`, `room:${day(1)}`]);
    expect(bill?.status).toBe('open');
    const lineIds = bill?.lines.map((line) => line.lineId).sort();

    const second = await inA(() => billing.syncOpenBills());
    expect(second).toMatchObject({ synced: 1, failures: [] });
    const again = await billOf(bookingId);
    expect(keysOf(again)).toEqual(keysOf(bill));
    // Not rebuilt either: the very same lines are still there.
    expect(again?.lines.map((line) => line.lineId).sort()).toEqual(lineIds);
    expect(await inA(() => Bill.countDocuments({ bookingId: new Types.ObjectId(bookingId) }))).toBe(
      1,
    );
  });

  it('adds only what is new on a later run, such as a delivered food order', async () => {
    const { bookingId } = await checkInGuest(desk, ids, '102', 'Standard', nextPhone());
    await inA(() => billing.syncOpenBills());
    const before = await billOf(bookingId);

    const order = await inA(() =>
      FoodOrder.create({
        code: 'SYNC-1',
        roomId: new Types.ObjectId(ids.rooms['102']),
        roomNumber: '102',
        bookingId: new Types.ObjectId(bookingId),
        guestName: 'In House Guest',
        items: [
          {
            menuItemId: new Types.ObjectId(),
            name: 'Tea',
            quantity: 1,
            unitPricePaise: 20_000,
            lineTotalPaise: 20_000,
          },
        ],
        subtotalPaise: 20_000,
        status: 'delivered',
        deliveredAt: new Date(),
      }),
    );
    await inA(() => billing.syncOpenBills());
    await inA(() => billing.syncOpenBills());
    const after = await billOf(bookingId);
    expect(keysOf(after)).toEqual([...keysOf(before), `food:${order._id.toHexString()}`].sort());
  });

  it('keeps going when one booking cannot be billed, and says which one failed', async () => {
    // A checked-in booking whose room no longer exists cannot get a bill. It is created first,
    // so it is reached before the good one.
    const broken = await plantBooking(a, {
      status: 'checked_in',
      roomId: new Types.ObjectId(),
      checkInDate: today(),
      checkOutDate: day(1),
    });
    const { bookingId } = await checkInGuest(desk, ids, '103', 'Standard', nextPhone());

    const result = await inA(() => billing.syncOpenBills());
    expect(result.failures.map((failure) => failure.bookingId)).toEqual([broken.id.toHexString()]);
    expect(result.failures[0]?.error).toBeInstanceOf(Error);
    expect(keysOf(await billOf(bookingId))).toEqual([`room:${today()}`, `room:${day(1)}`]);
  });

  it('only looks at checked-in guests of the property it runs in', async () => {
    const deskB = await t.actAs(b.staff.front_desk!.id, b.id);
    const idsB = await lookup(deskB);
    const { bookingId } = await checkInGuest(deskB, idsB, '101', 'Standard', nextPhone());
    await inA(() => billing.syncOpenBills());
    const inB = await runWithTenant(b.id, () =>
      Bill.findOne({ bookingId: new Types.ObjectId(bookingId) }).lean(),
    );
    expect(inB).toBeNull();
  });
});

describe('billing sync job handler', () => {
  it('logs each booking that failed and still succeeds when others were synced', async () => {
    const error = vi.fn();
    const broken = await plantBooking(a, {
      status: 'checked_in',
      roomId: new Types.ObjectId(),
      checkInDate: today(),
      checkOutDate: day(1),
    });
    await expect(runHandler(a, { error })).resolves.toBeUndefined();
    const logged = error.mock.calls.map(([fields]) => (fields as { bookingId: string }).bookingId);
    expect(logged).toContain(broken.id.toHexString());
  });

  it('fails the job (so it is retried and reported) when nothing at all could be synced', async () => {
    // Only a booking with no room is left checked in, so every attempt fails.
    const only = await plantBooking(b, {
      status: 'checked_in',
      roomId: new Types.ObjectId(),
      checkInDate: today(),
      checkOutDate: day(1),
    });
    await runWithTenant(b.id, () =>
      Booking.updateMany(
        { _id: { $ne: only.id }, status: 'checked_in' },
        { status: 'checked_out' },
      ),
    );
    const error = vi.fn();
    await expect(runHandler(b, { error })).rejects.toThrow(/could not be synced/i);
    expect(error).toHaveBeenCalled();
  });

  it('does nothing, and does not fail, when nobody is checked in', async () => {
    const empty = pino({ level: 'silent' });
    await runWithTenant(b.id, () =>
      Booking.updateMany({ status: 'checked_in' }, { status: 'checked_out' }),
    );
    await expect(runHandler(b, empty)).resolves.toBeUndefined();
  });
});
