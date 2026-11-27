import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { clientFor, line, plantBill } from '../../../test/manager';
import { BackgroundJob } from '../../jobs/job.model';
import { localDateTimeToUtc } from '../../shared/dates';
import { runWithTenant } from '../../shared/request-context';
import { CreditNote } from '../billing/credit-note.model';
import { Payment } from '../billing/payment.model';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';

useTestDatabase();

const TZ = 'Asia/Kolkata';
const D = '2026-03-10';
const D1 = '2026-03-11';
const t = buildTestApp();
let a: SeededProperty;
let b: SeededProperty;
let manager: Client;

const at = (date: string, time: string): Date => localDateTimeToUtc(date, time, TZ);
const zero = { taxablePaise: 0, taxPaise: 0, totalPaise: 0 };

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await clientFor(t, a, 'manager');
  await plantFixture();
});

function paymentDoc(
  billId: Types.ObjectId,
  kind: 'payment' | 'refund',
  amountPaise: number,
  createdAt: Date,
) {
  return {
    billId,
    bookingId: new Types.ObjectId(),
    bookingCode: 'B',
    guestName: 'Guest',
    kind,
    method: 'cash' as const,
    amountPaise,
    recordedBy: 'Desk',
    createdAt,
  };
}

async function plantFixture(): Promise<void> {
  const bookingId = new Types.ObjectId();
  const billId = await plantBill(a, bookingId, [
    line({
      lineId: 'room-1',
      category: 'room',
      serviceDate: D,
      taxablePaise: 200_000,
      ratePercent: 5,
      taxPaise: 10_000,
    }),
    line({
      lineId: 'food-1',
      category: 'food',
      serviceDate: D,
      taxablePaise: 35_000,
      ratePercent: 5,
      taxPaise: 1_750,
    }),
    line({
      lineId: 'disc-1',
      category: 'other',
      kind: 'discount',
      serviceDate: D,
      taxablePaise: -10_000,
      ratePercent: 18,
      taxPaise: -1_800,
    }),
    // Outside the range that most tests ask about.
    line({
      lineId: 'room-2',
      category: 'room',
      serviceDate: '2026-03-20',
      taxablePaise: 999_999,
      ratePercent: 5,
      taxPaise: 1,
    }),
    // A discount that was entered under food is still reported as a discount.
    line({
      lineId: 'disc-2',
      category: 'food',
      kind: 'discount',
      serviceDate: '2026-03-15',
      taxablePaise: -5_000,
      ratePercent: 5,
      taxPaise: -250,
    }),
  ]);
  await runWithTenant(a.id, async () => {
    // The credit note is issued at 00:30 local time on D+1, which is still day D in UTC.
    await CreditNote.create({
      billId,
      bookingId,
      invoiceNumber: 'INV/1',
      number: 'CN/1',
      lineId: 'food-1',
      description: 'Food',
      taxablePaise: 35_000,
      cgstPaise: 875,
      sgstPaise: 875,
      igstPaise: 0,
      taxPaise: 1_750,
      totalPaise: 36_750,
      reason: 'Wrong order',
      issuedBy: 'Manager',
      issuedAt: at(D1, '00:30'),
    });
    await Payment.create([
      paymentDoc(billId, 'payment', 100_000, at(D, '12:00')),
      paymentDoc(billId, 'refund', 20_000, at(D, '15:00')),
      // 23:59 local on D is D, and 00:30 local on D+1 is D+1 although it is still D in UTC.
      paymentDoc(billId, 'payment', 5_000, at(D, '23:59')),
      paymentDoc(billId, 'payment', 7_000, at(D1, '00:30')),
    ]);
  });
  // Another property's money on the same days must never show up.
  const otherBill = await plantBill(b, new Types.ObjectId(), [
    line({
      lineId: 'x',
      category: 'room',
      serviceDate: D,
      taxablePaise: 777_777,
      ratePercent: 5,
      taxPaise: 1,
    }),
  ]);
  await runWithTenant(b.id, () =>
    Payment.create(paymentDoc(otherBill, 'payment', 555_555, at(D, '12:00'))),
  );
}

const revenue = (from: string, to: string, client: Client = manager) =>
  client.get(`/api/v1/manager/stats/revenue?from=${from}&to=${to}`);

describe('GET /manager/stats/revenue', () => {
  it('splits posted lines by day and department, with GST kept apart and credit notes subtracted', async () => {
    const res = await revenue(D, D1);
    expect(res.status).toBe(200);
    const { days, totals } = res.body.data;

    expect(days).toHaveLength(2);
    expect(days[0]).toEqual({
      date: D,
      departments: {
        room: { taxablePaise: 200_000, taxPaise: 10_000, totalPaise: 210_000 },
        food: { taxablePaise: 35_000, taxPaise: 1_750, totalPaise: 36_750 },
        spa_recreation: zero,
        other: { taxablePaise: -10_000, taxPaise: -1_800, totalPaise: -11_800 },
      },
      total: { taxablePaise: 225_000, taxPaise: 9_950, totalPaise: 234_950 },
    });
    // The credit note reverses the food line on the day it was issued, in the property's timezone.
    expect(days[1]).toEqual({
      date: D1,
      departments: {
        room: zero,
        food: { taxablePaise: -35_000, taxPaise: -1_750, totalPaise: -36_750 },
        spa_recreation: zero,
        other: zero,
      },
      total: { taxablePaise: -35_000, taxPaise: -1_750, totalPaise: -36_750 },
    });
    expect(totals).toEqual({
      departments: {
        room: { taxablePaise: 200_000, taxPaise: 10_000, totalPaise: 210_000 },
        food: zero,
        spa_recreation: zero,
        other: { taxablePaise: -10_000, taxPaise: -1_800, totalPaise: -11_800 },
      },
      total: { taxablePaise: 190_000, taxPaise: 8_200, totalPaise: 198_200 },
    });
  });

  it('reports payments and refunds on the property-local day', async () => {
    const res = await revenue(D, D1);
    expect(res.body.data.payments).toEqual([
      { date: D, receivedPaise: 105_000, refundedPaise: 20_000 },
      { date: D1, receivedPaise: 7_000, refundedPaise: 0 },
    ]);
  });

  it('reports a discount entered under food as a negative "other" amount', async () => {
    const res = await revenue('2026-03-15', '2026-03-15');
    expect(res.body.data.days[0].departments).toEqual({
      room: zero,
      food: zero,
      spa_recreation: zero,
      other: { taxablePaise: -5_000, taxPaise: -250, totalPaise: -5_250 },
    });
  });

  it('shows days with no activity as real zeros and ignores lines outside the range', async () => {
    const res = await revenue('2026-03-12', '2026-03-13');
    expect(res.body.data.days.map((d: { total: unknown }) => d.total)).toEqual([zero, zero]);
    expect(res.body.data.payments).toEqual([
      { date: '2026-03-12', receivedPaise: 0, refundedPaise: 0 },
      { date: '2026-03-13', receivedPaise: 0, refundedPaise: 0 },
    ]);
  });

  it('never includes another property', async () => {
    const managerB = await clientFor(t, b, 'manager');
    const res = await revenue(D, D, managerB);
    expect(res.body.data.days[0].departments.room.taxablePaise).toBe(777_777);
    expect(res.body.data.payments).toEqual([{ date: D, receivedPaise: 555_555, refundedPaise: 0 }]);
  });

  it('says when the bills were last brought up to date, or null if that never happened', async () => {
    expect((await revenue(D, D)).body.data.lastSyncedAt).toBeNull();

    const finished = new Date('2026-03-10T08:15:00Z');
    await runWithTenant(a.id, () =>
      BackgroundJob.create({
        type: 'billing.sync_open',
        dedupeKey: 'recurring:billing.sync_open',
        runAt: finished,
        status: 'pending',
        lastFinishedAt: finished,
        recurring: { everyMs: 900_000 },
      }),
    );
    await runWithTenant(b.id, () =>
      BackgroundJob.create({
        type: 'billing.sync_open',
        dedupeKey: 'recurring:billing.sync_open',
        runAt: new Date(),
        status: 'pending',
        lastFinishedAt: new Date('2026-03-12T00:00:00Z'),
        recurring: { everyMs: 900_000 },
      }),
    );
    expect((await revenue(D, D)).body.data.lastSyncedAt).toBe('2026-03-10T08:15:00.000Z');
  });

  it('refuses a backwards range and one over 92 days', async () => {
    expect((await revenue(D1, D)).status).toBe(400);
    expect((await revenue('2026-01-01', '2026-04-03')).status).toBe(400);
    expect((await revenue('2026-01-01', '2026-04-02')).status).toBe(200);
  });
});
