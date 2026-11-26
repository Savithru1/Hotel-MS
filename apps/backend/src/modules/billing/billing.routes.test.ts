import { MANUAL_APPROVAL_LIMIT_PAISE, type StaffRole } from '@hospitality/constants';
import type {
  BillDto,
  BillSummaryDto,
  FacilityDto,
  MenuItemDto,
  PaymentDto,
  PaymentsSummaryDto,
} from '@hospitality/shared-types';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { day, lookup, today, type Lookup } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Bill } from './bill.model';
import { Counter } from './counter.model';
import { financialYear } from './gst';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
let ids: Lookup;
const t = buildTestApp();

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

let manager: Client;
let desk: Client;
let spa: Client;
let kitchen: Client;
let otherManager: Client;

const BILLS = '/api/v1/bills';
const PAYMENTS = '/api/v1/payments';
const NIGHT_PAISE = 250_000; // a Standard room
const NIGHT_TAX = 12_500; // 5% of a Standard night
const FY = financialYear(today());

let chai: MenuItemDto;
let studio: FacilityDto;
let phoneCounter = 0;
let roomCounter = 300;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await as(a, 'manager');
  desk = await as(a, 'front_desk');
  spa = await as(a, 'spa_recreation');
  kitchen = await as(a, 'kitchen');
  otherManager = await as(b, 'manager');
  ids = await lookup(desk);
  // Plenty of spare rooms, so every test can check a fresh guest into its own.
  for (let n = 301; n <= 390; n++) {
    const res = await manager.post('/api/v1/rooms', {
      number: String(n),
      floor: 3,
      roomTypeId: ids.types.Standard,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  ids = await lookup(desk);

  const item = await manager.post('/api/v1/menu/items', {
    name: 'Masala Chai',
    category: 'Drinks',
    pricePaise: 8_000,
  });
  chai = item.body.data as MenuItemDto;
  const facility = await manager.post('/api/v1/facilities', {
    name: 'Yoga Studio',
    type: 'activity',
    capacity: 100,
    slotMinutes: 60,
    opensAt: '09:00',
    closesAt: '18:00',
    pricePaise: 150_000,
  });
  studio = facility.body.data as FacilityDto;
});

interface Stay {
  bookingId: string;
  room: string;
  roomId: string;
}

/** Books and checks in a new guest. Standard rooms by default (Rs 2,500 a night). */
async function stay(
  options: { room?: string; nights?: number; gstin?: string; type?: string } = {},
): Promise<Stay> {
  const room = options.room ?? String(++roomCounter);
  const phone = `+9170${String(100_000_000 + ++phoneCounter).slice(1)}`;
  const name = `Guest ${phoneCounter}`;
  let who: Record<string, unknown> = { guest: { name, phone } };
  if (options.gstin) {
    const guest = await desk.post('/api/v1/guests', { name, phone, gstin: options.gstin });
    expect(guest.status, JSON.stringify(guest.body)).toBe(201);
    who = { guestId: guest.body.data.id };
  }
  const booked = await desk.post('/api/v1/bookings', {
    ...who,
    roomTypeId: ids.types[options.type ?? 'Standard'],
    roomId: ids.rooms[room],
    checkInDate: day(0),
    checkOutDate: day(options.nights ?? 2),
    adults: 1,
  });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const checkedIn = await desk.post(`/api/v1/bookings/${booked.body.data.id}/check-in`, {});
  expect(checkedIn.status, JSON.stringify(checkedIn.body)).toBe(200);
  return { bookingId: booked.body.data.id as string, room, roomId: ids.rooms[room] as string };
}

async function billOf(guest: Stay, client: Client = desk): Promise<BillDto> {
  const res = await client.get(`${BILLS}/by-booking/${guest.bookingId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as BillDto;
}

async function deliverChai(guest: Stay, quantity = 2): Promise<{ id: string; code: string }> {
  const placed = await desk.post('/api/v1/food-orders', {
    roomId: guest.roomId,
    items: [{ menuItemId: chai.id, quantity }],
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const id = placed.body.data.id as string;
  for (const step of ['start', 'ready', 'deliver']) {
    expect((await kitchen.post(`/api/v1/food-orders/${id}/${step}`)).status).toBe(200);
  }
  return { id, code: placed.body.data.code as string };
}

async function completeStudio(guest: Stay, participants = 2): Promise<string> {
  const booked = await desk.post('/api/v1/facility-bookings', {
    facilityId: studio.id,
    roomId: guest.roomId,
    date: day(1),
    startTime: '10:00',
    participants,
  });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const id = booked.body.data.id as string;
  for (const step of ['confirm', 'start', 'complete']) {
    expect((await spa.post(`/api/v1/facility-bookings/${id}/${step}`)).status).toBe(200);
  }
  return id;
}

const charge = (extra: Record<string, unknown> = {}) => ({
  kind: 'charge',
  category: 'other',
  description: 'Laundry',
  amountPaise: 25_000,
  reason: 'Same-day laundry',
  ...extra,
});

describe('opening a bill', () => {
  it('builds the bill from the stay: one room line per night, taxed and copied', async () => {
    const guest = await stay();
    const bill = await billOf(guest);

    expect(bill).toMatchObject({
      bookingId: guest.bookingId,
      roomNumber: guest.room,
      status: 'open',
      nights: 2,
      invoice: null,
      paidPaise: 0,
      balancePaise: 2 * (NIGHT_PAISE + NIGHT_TAX),
    });
    expect(bill.guest.name).toMatch(/^Guest /);
    expect(bill.lines).toHaveLength(2);
    expect(bill.lines.map((l) => l.serviceDate)).toEqual([day(0), day(1)]);
    for (const line of bill.lines) {
      expect(line).toMatchObject({
        kind: 'room',
        category: 'room',
        quantity: 1,
        unitPaise: NIGHT_PAISE,
        taxablePaise: NIGHT_PAISE,
        ratePercent: 5,
        cgstPaise: 6_250,
        sgstPaise: 6_250,
        igstPaise: 0,
        taxPaise: NIGHT_TAX,
        totalPaise: NIGHT_PAISE + NIGHT_TAX,
        sacCode: '996311',
        manual: false,
        creditNoteNumber: null,
      });
      expect(line.description).toContain(`Room ${guest.room}`);
    }
    expect(bill.totals).toEqual({
      taxablePaise: 500_000,
      cgstPaise: 12_500,
      sgstPaise: 12_500,
      igstPaise: 0,
      taxPaise: 25_000,
      subtotalPaise: 525_000,
      roundOffPaise: 0,
      totalPaise: 525_000,
    });
  });

  it('is safe to ask for again and again, even all at once: still one bill, one line per night', async () => {
    const guest = await stay();
    const replies = await Promise.all(
      Array.from({ length: 6 }, () => desk.get(`${BILLS}/by-booking/${guest.bookingId}`)),
    );
    for (const reply of replies) {
      expect(reply.status).toBe(200);
      expect((reply.body.data as BillDto).lines).toHaveLength(2);
    }
    expect(
      await runWithTenant(a.id, () => Bill.countDocuments({ bookingId: guest.bookingId })),
    ).toBe(1);
    const stored = await runWithTenant(a.id, () =>
      Bill.findOne({ bookingId: guest.bookingId }).lean(),
    );
    expect(new Set(stored?.lines.map((l) => l.sourceKey)).size).toBe(2);
    expect(replies[0]?.body.data.id).toBe(replies[5]?.body.data.id);
  });

  it('can be fetched by its own id and listed', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const byId = await desk.get(`${BILLS}/${bill.id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.data.id).toBe(bill.id);

    const list = await manager.get(`${BILLS}?bookingId=${guest.bookingId}`);
    expect((list.body.data as BillSummaryDto[]).map((s) => s.id)).toEqual([bill.id]);
    expect(list.body.data[0]).toMatchObject({
      bookingCode: expect.any(String),
      status: 'open',
      invoiceNumber: null,
      totalPaise: 525_000,
      balancePaise: 525_000,
    });
    const open = await manager.get(`${BILLS}?status=open&limit=100`);
    expect((open.body.data as BillSummaryDto[]).some((s) => s.id === bill.id)).toBe(true);
    expect((await manager.get(`${BILLS}?status=paid`)).status).toBe(400);
  });

  it('refuses a booking whose guest has not checked in, an unknown booking and a malformed id', async () => {
    const future = await desk.post('/api/v1/bookings', {
      guest: { name: 'Future Guest', phone: '+917000999001' },
      roomTypeId: ids.types.Standard,
      roomId: ids.rooms['390'],
      checkInDate: day(5),
      checkOutDate: day(7),
      adults: 1,
    });
    const notYet = await desk.get(`${BILLS}/by-booking/${future.body.data.id}`);
    expect(notYet.status).toBe(409);
    expect(notYet.body.error.code).toBe('not_checked_in');
    expect((await desk.get(`${BILLS}/by-booking/0123456789abcdef01234567`)).status).toBe(404);
    expect((await desk.get(`${BILLS}/by-booking/nope`)).status).toBe(400);
    expect((await desk.get(`${BILLS}/0123456789abcdef01234567`)).status).toBe(404);
  });

  it('follows a stay that is extended: the new night is added, nothing is posted twice', async () => {
    const guest = await stay({ nights: 2 });
    await billOf(guest);
    const extended = await desk.patch(`/api/v1/bookings/${guest.bookingId}`, {
      checkOutDate: day(3),
    });
    expect(extended.status, JSON.stringify(extended.body)).toBe(200);
    const bill = await billOf(guest);
    expect(bill.lines.map((l) => l.serviceDate)).toEqual([day(0), day(1), day(2)]);
    expect(bill.nights).toBe(3);
  });
});

describe('what goes on the bill, and how it is taxed', () => {
  it('posts a delivered food order once, at 5%, and not an order that is only placed or was cancelled', async () => {
    const guest = await stay();
    const delivered = await deliverChai(guest, 2);
    const placed = await desk.post('/api/v1/food-orders', {
      roomId: guest.roomId,
      items: [{ menuItemId: chai.id, quantity: 1 }],
    });
    const cancelled = await desk.post('/api/v1/food-orders', {
      roomId: guest.roomId,
      items: [{ menuItemId: chai.id, quantity: 1 }],
    });
    await kitchen.post(`/api/v1/food-orders/${cancelled.body.data.id}/cancel`, {
      reason: 'Guest left',
    });

    const replies = await Promise.all(
      Array.from({ length: 4 }, () => desk.get(`${BILLS}/by-booking/${guest.bookingId}`)),
    );
    for (const reply of replies) {
      const food = (reply.body.data as BillDto).lines.filter((l) => l.kind === 'food');
      expect(food).toHaveLength(1);
      expect(food[0]).toMatchObject({
        category: 'food',
        quantity: 1,
        taxablePaise: 16_000,
        ratePercent: 5,
        cgstPaise: 400,
        sgstPaise: 400,
        taxPaise: 800,
        totalPaise: 16_800,
        sacCode: '996331',
        serviceDate: day(0),
      });
      expect(food[0]?.description).toContain(delivered.code);
    }
    expect(placed.status).toBe(201);
  });

  it('posts a completed facility booking at 18%, and not a cancelled or no-show one', async () => {
    const guest = await stay();
    await completeStudio(guest, 2);
    const cancelled = await desk.post('/api/v1/facility-bookings', {
      facilityId: studio.id,
      roomId: guest.roomId,
      date: day(1),
      startTime: '11:00',
    });
    await desk.post(`/api/v1/facility-bookings/${cancelled.body.data.id}/cancel`, {
      reason: 'Changed plans',
    });

    const bill = await billOf(guest);
    const facility = bill.lines.filter((l) => l.kind === 'facility');
    expect(facility).toHaveLength(1);
    expect(facility[0]).toMatchObject({
      category: 'spa_recreation',
      taxablePaise: 300_000,
      ratePercent: 18,
      cgstPaise: 27_000,
      sgstPaise: 27_000,
      taxPaise: 54_000,
      totalPaise: 354_000,
      sacCode: '999722',
      serviceDate: day(1),
    });
    expect(facility[0]?.description).toContain('Yoga Studio');
    expect((await billOf(guest)).lines.filter((l) => l.kind === 'facility')).toHaveLength(1);
  });

  it('keeps a line exactly as posted when prices change afterwards', async () => {
    const guest = await stay();
    await completeStudio(guest, 1);
    const before = await billOf(guest);
    await manager.patch(`/api/v1/facilities/${studio.id}`, { pricePaise: 999_000 });
    await manager.patch(`/api/v1/menu/items/${chai.id}`, { pricePaise: 99_000 });
    const after = await billOf(guest);
    await manager.patch(`/api/v1/facilities/${studio.id}`, { pricePaise: 150_000 });
    await manager.patch(`/api/v1/menu/items/${chai.id}`, { pricePaise: 8_000 });
    expect(after.lines.find((l) => l.kind === 'facility')).toEqual(
      before.lines.find((l) => l.kind === 'facility'),
    );
    expect(after.totals).toEqual(before.totals);
  });

  it('charges IGST instead of CGST and SGST to a guest whose GSTIN is in another state', async () => {
    const guest = await stay({ gstin: '29AAAAA0000A1Z5' });
    await deliverChai(guest, 2);
    const bill = await billOf(guest);
    expect(bill.guest.gstin).toBe('29AAAAA0000A1Z5');
    for (const line of bill.lines) {
      expect(line).toMatchObject({ cgstPaise: 0, sgstPaise: 0 });
      expect(line.igstPaise).toBe(line.taxPaise);
      expect(line.taxPaise).toBeGreaterThan(0);
    }
    expect(bill.lines[0]?.igstPaise).toBe(NIGHT_TAX);
    expect(bill.totals.cgstPaise).toBe(0);
    expect(bill.totals.igstPaise).toBe(bill.totals.taxPaise);
  });

  it('charges CGST and SGST to a guest whose GSTIN is in the property’s own state', async () => {
    const guest = await stay({ gstin: '27AAAAA0000A1Z5' });
    const bill = await billOf(guest);
    expect(bill.lines[0]).toMatchObject({ cgstPaise: 6_250, sgstPaise: 6_250, igstPaise: 0 });
  });

  it('uses the higher slab for a suite: 18% on the room and on food', async () => {
    const guest = await stay({ room: '205', type: 'Suite', nights: 1 });
    await deliverChai(guest, 1);
    const bill = await billOf(guest);
    expect(bill.lines.find((l) => l.kind === 'room')).toMatchObject({
      ratePercent: 18,
      taxablePaise: 900_000,
      cgstPaise: 81_000,
      sgstPaise: 81_000,
    });
    expect(bill.lines.find((l) => l.kind === 'food')).toMatchObject({ ratePercent: 18 });
  });

  it('records which rules each line was taxed under', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const stored = await runWithTenant(a.id, () => Bill.findOne({ _id: bill.id }).lean());
    for (const line of stored?.lines ?? []) expect(line.ruleEffectiveFrom).toBe('2025-04-01');
  });
});

describe('charges and discounts added by hand', () => {
  it('adds a charge, taxes it at 18% on the server, and records who and why', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const res = await desk.post(`${BILLS}/${bill.id}/lines`, charge());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const line = (res.body.data as BillDto).lines.find((l) => l.manual);
    expect(line).toMatchObject({
      kind: 'charge',
      category: 'other',
      description: 'Laundry',
      quantity: 1,
      unitPaise: 25_000,
      taxablePaise: 25_000,
      ratePercent: 18,
      cgstPaise: 2_250,
      sgstPaise: 2_250,
      totalPaise: 29_500,
      reason: 'Same-day laundry',
      manual: true,
    });
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'bill.line_added', 'target.id': bill.id }).lean(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.summary).toMatchObject({ kind: 'charge', taxablePaise: 25_000 });
  });

  it('multiplies by the quantity, and a discount takes money off with a matching tax reduction', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const three = await desk.post(`${BILLS}/${bill.id}/lines`, charge({ quantity: 3 }));
    expect((three.body.data as BillDto).lines.find((l) => l.manual)?.taxablePaise).toBe(75_000);

    const discount = await desk.post(
      `${BILLS}/${bill.id}/lines`,
      charge({ kind: 'discount', description: 'Loyalty discount', amountPaise: 10_000 }),
    );
    const line = (discount.body.data as BillDto).lines.find((l) => l.kind === 'discount');
    expect(line).toMatchObject({
      taxablePaise: -10_000,
      cgstPaise: -900,
      sgstPaise: -900,
      taxPaise: -1_800,
      totalPaise: -11_800,
    });
    // Two nights (525,000) + three laundry items with tax (88,500) - the discount with tax (11,800).
    expect((discount.body.data as BillDto).totals.totalPaise).toBe(601_700);
  });

  it('lets the front desk add up to the limit, and needs a manager above it', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    expect(
      (
        await desk.post(
          `${BILLS}/${bill.id}/lines`,
          charge({ amountPaise: MANUAL_APPROVAL_LIMIT_PAISE }),
        )
      ).status,
    ).toBe(201);

    const over = await desk.post(
      `${BILLS}/${bill.id}/lines`,
      charge({ amountPaise: MANUAL_APPROVAL_LIMIT_PAISE + 100 }),
    );
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('approval_required');
    const bigDiscount = await desk.post(
      `${BILLS}/${bill.id}/lines`,
      charge({ kind: 'discount', amountPaise: MANUAL_APPROVAL_LIMIT_PAISE + 100 }),
    );
    expect(bigDiscount.body.error.code).toBe('approval_required');
    // Several units that together go over the limit count too.
    const many = await desk.post(
      `${BILLS}/${bill.id}/lines`,
      charge({ amountPaise: 300_000, quantity: 2 }),
    );
    expect(many.body.error.code).toBe('approval_required');

    const approved = await manager.post(
      `${BILLS}/${bill.id}/lines`,
      charge({ amountPaise: MANUAL_APPROVAL_LIMIT_PAISE + 100, description: 'Banquet extras' }),
    );
    expect(approved.status).toBe(201);
    const line = (approved.body.data as BillDto).lines.find(
      (l) => l.description === 'Banquet extras',
    );
    expect(line?.approvedBy).toBeTruthy();
  });

  it('rejects a missing reason, the room category, a zero amount and a client-supplied tax', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    for (const bad of [
      charge({ reason: '' }),
      charge({ category: 'room' }),
      charge({ amountPaise: 0 }),
      charge({ amountPaise: -500 }),
      charge({ description: '' }),
    ]) {
      const res = await desk.post(`${BILLS}/${bill.id}/lines`, bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
    const sneaky = await desk.post(
      `${BILLS}/${bill.id}/lines`,
      charge({ ratePercent: 0, taxPaise: 0, totalPaise: 1 }),
    );
    expect(sneaky.status).toBe(201);
    expect((sneaky.body.data as BillDto).lines.find((l) => l.manual)).toMatchObject({
      ratePercent: 18,
      taxPaise: 4_500,
    });
  });

  it('removes a manual line, but never a room, food or facility line', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const added = await desk.post(`${BILLS}/${bill.id}/lines`, charge());
    const manualId = (added.body.data as BillDto).lines.find((l) => l.manual)?.id as string;

    const refused = await desk.delete(`${BILLS}/${bill.id}/lines/${bill.lines[0]?.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('not_manual');
    expect((await desk.delete(`${BILLS}/${bill.id}/lines/does-not-exist`)).status).toBe(404);

    const removed = await desk.delete(`${BILLS}/${bill.id}/lines/${manualId}`);
    expect(removed.status).toBe(200);
    expect((removed.body.data as BillDto).lines.some((l) => l.manual)).toBe(false);
    expect((removed.body.data as BillDto).totals.totalPaise).toBe(525_000);
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'bill.line_removed', 'target.id': bill.id }).lean(),
    );
    expect(audits).toHaveLength(1);
  });

  it('needs a manager to remove a manual line that was above the limit', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const added = await manager.post(
      `${BILLS}/${bill.id}/lines`,
      charge({ amountPaise: MANUAL_APPROVAL_LIMIT_PAISE + 100 }),
    );
    const lineId = (added.body.data as BillDto).lines.find((l) => l.manual)?.id as string;
    const refused = await desk.delete(`${BILLS}/${bill.id}/lines/${lineId}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('approval_required');
    expect((await manager.delete(`${BILLS}/${bill.id}/lines/${lineId}`)).status).toBe(200);
  });
});

describe('recording payments', () => {
  it('takes part payments, keeps the balance, and records each one in the ledger', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const first = await desk.post(`${BILLS}/${bill.id}/payments`, {
      method: 'cash',
      amountPaise: 100_000,
      reference: 'Receipt 41',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({ paidPaise: 100_000, balancePaise: 425_000 });
    expect(first.body.data.payments[0]).toMatchObject({
      kind: 'payment',
      method: 'cash',
      amountPaise: 100_000,
      reference: 'Receipt 41',
      bookingId: guest.bookingId,
    });
    const second = await desk.post(`${BILLS}/${bill.id}/payments`, {
      method: 'upi',
      amountPaise: 25_000,
    });
    expect(second.body.data).toMatchObject({ paidPaise: 125_000, balancePaise: 400_000 });

    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'bill.payment_recorded', 'target.id': bill.id }).lean(),
    );
    expect(audits).toHaveLength(2);
  });

  it('settles the whole bill exactly, and then refuses more money', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const full = await desk.post(`${BILLS}/${bill.id}/payments`, {
      method: 'card',
      amountPaise: 525_000,
    });
    expect(full.body.data.balancePaise).toBe(0);
    const extra = await desk.post(`${BILLS}/${bill.id}/payments`, {
      method: 'cash',
      amountPaise: 100,
    });
    expect(extra.status).toBe(409);
    expect(extra.body.error.code).toBe('overpayment');
  });

  it('refuses more than is owed, and takes the charges added since into account', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const tooMuch = await desk.post(`${BILLS}/${bill.id}/payments`, {
      method: 'cash',
      amountPaise: 525_100,
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('overpayment');
    await deliverChai(guest, 2);
    expect(
      (await desk.post(`${BILLS}/${bill.id}/payments`, { method: 'cash', amountPaise: 541_800 }))
        .status,
    ).toBe(201);
  });

  it('lets only one of two simultaneous payments that together are too much succeed', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const results = await Promise.all([
      desk.post(`${BILLS}/${bill.id}/payments`, { method: 'cash', amountPaise: 300_000 }),
      manager.post(`${BILLS}/${bill.id}/payments`, { method: 'upi', amountPaise: 300_000 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const fresh = await desk.get(`${BILLS}/${bill.id}`);
    expect(fresh.body.data.paidPaise).toBe(300_000);
    expect(fresh.body.data.payments).toHaveLength(1);
  });

  it('rejects a bad method, a zero amount and a fractional amount', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    for (const bad of [
      { method: 'bitcoin', amountPaise: 100 },
      { method: 'cash', amountPaise: 0 },
      { method: 'cash', amountPaise: 99.5 },
      { amountPaise: 100 },
    ]) {
      const res = await desk.post(`${BILLS}/${bill.id}/payments`, bad);
      expect(res.status).toBe(400);
    }
  });
});

describe('refunds', () => {
  it('are for managers only, need a reason, and cannot be more than was paid', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    await desk.post(`${BILLS}/${bill.id}/payments`, { method: 'cash', amountPaise: 100_000 });

    const body = { method: 'cash', amountPaise: 30_000, reason: 'Overcharged for laundry' };
    expect((await desk.post(`${BILLS}/${bill.id}/refunds`, body)).status).toBe(403);
    expect(
      (await manager.post(`${BILLS}/${bill.id}/refunds`, { ...body, reason: '' })).status,
    ).toBe(400);
    const tooMuch = await manager.post(`${BILLS}/${bill.id}/refunds`, {
      ...body,
      amountPaise: 100_100,
    });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('refund_too_large');

    const ok = await manager.post(`${BILLS}/${bill.id}/refunds`, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data).toMatchObject({ paidPaise: 100_000, refundedPaise: 30_000 });
    expect(ok.body.data.balancePaise).toBe(525_000 - 70_000);
    const refund = (ok.body.data as BillDto).payments.find((p) => p.kind === 'refund');
    expect(refund).toMatchObject({ amountPaise: 30_000, reason: 'Overcharged for laundry' });
    // The most that can still be refunded is what is left after earlier refunds.
    expect(
      (await manager.post(`${BILLS}/${bill.id}/refunds`, { ...body, amountPaise: 70_100 })).status,
    ).toBe(409);
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'bill.refund_recorded', 'target.id': bill.id }).lean(),
    );
    expect(audits).toHaveLength(1);
  });
});

describe('the invoice', () => {
  it('turns the bill into a numbered, immutable invoice with the supplier details copied', async () => {
    const guest = await stay();
    await deliverChai(guest, 2);
    const bill = await billOf(guest);
    const res = await desk.post(`${BILLS}/${bill.id}/finalize`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const done = res.body.data as BillDto;

    expect(done.status).toBe('finalized');
    expect(done.invoice?.number).toMatch(new RegExp(`^INV/${FY}/\\d{6}$`));
    expect(done.invoice).toMatchObject({
      financialYear: FY,
      supplier: { legalName: 'Grand Plaza Private Limited', stateName: 'Maharashtra' },
      placeOfSupplyState: 'Maharashtra',
      intraState: true,
    });
    expect(done.invoice?.totals).toEqual(done.totals);
    expect(done.totals.totalPaise % 100).toBe(0);
    expect(done.totals.totalPaise).toBe(done.totals.subtotalPaise + done.totals.roundOffPaise);
    expect(done.lines).toHaveLength(3);
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'bill.finalized', 'target.id': bill.id }).lean(),
    );
    expect(audits[0]?.summary).toMatchObject({ invoiceNumber: done.invoice?.number });
  });

  it('rounds the total to a whole rupee with a visible round-off', async () => {
    const guest = await stay({ nights: 1 });
    const bill = await billOf(guest);
    // Rs 99.99 at 18% makes the subtotal an odd number of paise.
    await desk.post(`${BILLS}/${bill.id}/lines`, charge({ amountPaise: 9_999 }));
    const done = (await desk.post(`${BILLS}/${bill.id}/finalize`)).body.data as BillDto;
    expect(done.totals.roundOffPaise).not.toBe(0);
    expect(Math.abs(done.totals.roundOffPaise)).toBeLessThan(100);
    expect(done.totals.totalPaise % 100).toBe(0);
    expect(done.balancePaise).toBe(done.totals.totalPaise);
  });

  it('does not change afterwards: no new charges, no removals, and later orders are not added', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const added = await desk.post(`${BILLS}/${bill.id}/lines`, charge());
    const manualId = (added.body.data as BillDto).lines.find((l) => l.manual)?.id as string;
    const done = (await desk.post(`${BILLS}/${bill.id}/finalize`)).body.data as BillDto;

    const more = await desk.post(`${BILLS}/${bill.id}/lines`, charge());
    expect(more.status).toBe(409);
    expect(more.body.error.code).toBe('bill_finalized');
    expect((await desk.delete(`${BILLS}/${bill.id}/lines/${manualId}`)).body.error.code).toBe(
      'bill_finalized',
    );

    // A new order cannot even be placed once the invoice is issued.
    const late = await desk.post('/api/v1/food-orders', {
      roomId: guest.roomId,
      items: [{ menuItemId: chai.id, quantity: 3 }],
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('invoice_issued');
    const again = (await desk.get(`${BILLS}/${bill.id}`)).body.data as BillDto;
    expect(again.lines).toEqual(done.lines);
    expect(again.invoice).toEqual(done.invoice);
    expect(again.totals).toEqual(done.totals);
  });

  it('cannot be finalized twice', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    expect((await desk.post(`${BILLS}/${bill.id}/finalize`)).status).toBe(200);
    const again = await desk.post(`${BILLS}/${bill.id}/finalize`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_finalized');
  });

  it('waits for open food orders and facility bookings, which have to be delivered or cancelled first', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const order = await desk.post('/api/v1/food-orders', {
      roomId: guest.roomId,
      items: [{ menuItemId: chai.id, quantity: 1 }],
    });
    const booking = await desk.post('/api/v1/facility-bookings', {
      facilityId: studio.id,
      roomId: guest.roomId,
      date: day(1),
      startTime: '12:00',
    });
    const blocked = await desk.post(`${BILLS}/${bill.id}/finalize`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('open_items');

    await kitchen.post(`/api/v1/food-orders/${order.body.data.id}/cancel`, {
      reason: 'Guest left',
    });
    await desk.post(`/api/v1/facility-bookings/${booking.body.data.id}/cancel`, {
      reason: 'Guest left',
    });
    expect((await desk.post(`${BILLS}/${bill.id}/finalize`)).status).toBe(200);
  });

  it('gives parallel finalizations consecutive numbers with no gaps and no repeats', async () => {
    const guests: Stay[] = [];
    for (let i = 0; i < 8; i++) guests.push(await stay());
    const bills = await Promise.all(guests.map((g) => billOf(g)));
    const results = await Promise.all(
      bills.map((bill) => desk.post(`${BILLS}/${bill.id}/finalize`)),
    );
    for (const res of results) expect(res.status, JSON.stringify(res.body)).toBe(200);

    const sequence = results
      .map((r) => Number((r.body.data as BillDto).invoice?.number.split('/')[2]))
      .sort((x, y) => x - y);
    expect(new Set(sequence).size).toBe(8);
    expect((sequence[7] ?? 0) - (sequence[0] ?? 0)).toBe(7);
  });

  it('gives a number back when finalizing fails halfway, so nothing is skipped', async () => {
    const first = await stay();
    const second = await stay();
    const firstBill = await billOf(first);
    const secondBill = await billOf(second);
    const counterNow = () =>
      runWithTenant(a.id, () => Counter.findOne({ key: `invoice:${FY}` }).lean());
    const seqBefore = (await counterNow())?.seq ?? 0;

    const failing = vi
      .spyOn(AuditLog, 'create')
      .mockRejectedValueOnce(new Error('audit store down'));
    const failed = await desk.post(`${BILLS}/${firstBill.id}/finalize`);
    failing.mockRestore();
    expect(failed.status).toBe(500);
    const stillOpen = (await desk.get(`${BILLS}/${firstBill.id}`)).body.data as BillDto;
    expect(stillOpen).toMatchObject({ status: 'open', invoice: null });
    expect((await counterNow())?.seq ?? 0).toBe(seqBefore);

    const retry = await desk.post(`${BILLS}/${firstBill.id}/finalize`);
    const next = await desk.post(`${BILLS}/${secondBill.id}/finalize`);
    const seq = (res: { body: { data: BillDto } }) =>
      Number(res.body.data.invoice?.number.split('/')[2]);
    expect(seq(retry)).toBe(seqBefore + 1);
    expect(seq(next)).toBe(seqBefore + 2);
  });
});

describe('credit notes', () => {
  async function invoiced() {
    const guest = await stay();
    await deliverChai(guest, 2);
    const bill = await billOf(guest);
    await desk.post(`${BILLS}/${bill.id}/lines`, charge());
    await desk.post(
      `${BILLS}/${bill.id}/lines`,
      charge({ kind: 'discount', description: 'Goodwill', amountPaise: 5_000 }),
    );
    const done = (await desk.post(`${BILLS}/${bill.id}/finalize`)).body.data as BillDto;
    return { guest, bill: done };
  }

  it('reverses one line of an issued invoice with its own gap-free number, and lowers what is owed', async () => {
    const { bill } = await invoiced();
    const food = bill.lines.find((l) => l.kind === 'food');
    const res = await manager.post(`${BILLS}/${bill.id}/credit-notes`, {
      lineId: food?.id,
      reason: 'Order was never delivered to the room',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const after = res.body.data as BillDto;

    expect(after.creditNotes).toHaveLength(1);
    expect(after.creditNotes[0]).toMatchObject({
      invoiceNumber: bill.invoice?.number,
      lineId: food?.id,
      taxablePaise: food?.taxablePaise,
      taxPaise: food?.taxPaise,
      totalPaise: food?.totalPaise,
      reason: 'Order was never delivered to the room',
    });
    expect(after.creditNotes[0]?.number).toMatch(new RegExp(`^CN/${FY}/\\d{6}$`));
    expect(after.creditNotePaise).toBe(food?.totalPaise);
    expect(after.balancePaise).toBe(bill.balancePaise - (food?.totalPaise ?? 0));
    expect(after.lines.find((l) => l.id === food?.id)?.creditNoteNumber).toBe(
      after.creditNotes[0]?.number,
    );
    // The invoice itself is untouched.
    expect(after.invoice).toEqual(bill.invoice);
    expect(after.totals).toEqual(bill.totals);
  });

  it('is for managers, finalized bills and real, reversible lines only', async () => {
    const guest = await stay();
    const open = await billOf(guest);
    const early = await manager.post(`${BILLS}/${open.id}/credit-notes`, {
      lineId: open.lines[0]?.id,
      reason: 'Too early',
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('not_finalized');

    const { bill } = await invoiced();
    const body = { lineId: bill.lines[0]?.id, reason: 'Wrong night' };
    expect((await desk.post(`${BILLS}/${bill.id}/credit-notes`, body)).status).toBe(403);
    expect(
      (await manager.post(`${BILLS}/${bill.id}/credit-notes`, { ...body, lineId: 'nope' })).status,
    ).toBe(404);
    const discount = bill.lines.find((l) => l.kind === 'discount');
    const refused = await manager.post(`${BILLS}/${bill.id}/credit-notes`, {
      lineId: discount?.id,
      reason: 'Undo discount',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('credit_not_allowed');
    expect(
      (await manager.post(`${BILLS}/${bill.id}/credit-notes`, { ...body, reason: '' })).status,
    ).toBe(400);
  });

  it('reverses a line only once, even when asked twice at the same moment', async () => {
    const { bill } = await invoiced();
    const body = { lineId: bill.lines[0]?.id, reason: 'Wrong night' };
    const results = await Promise.all([
      manager.post(`${BILLS}/${bill.id}/credit-notes`, body),
      (await as(a, 'property_admin')).post(`${BILLS}/${bill.id}/credit-notes`, body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.error.code).toBe('already_credited');
    const fresh = (await desk.get(`${BILLS}/${bill.id}`)).body.data as BillDto;
    expect(fresh.creditNotes).toHaveLength(1);
  });

  it('numbers credit notes one after another without gaps', async () => {
    const { bill } = await invoiced();
    const numbers: number[] = [];
    for (const line of bill.lines.filter((l) => l.kind !== 'discount').slice(0, 3)) {
      const res = await manager.post(`${BILLS}/${bill.id}/credit-notes`, {
        lineId: line.id,
        reason: 'Correction',
      });
      expect(res.status).toBe(201);
      const notes = (res.body.data as BillDto).creditNotes;
      numbers.push(Number(notes[notes.length - 1]?.number.split('/')[2]));
    }
    expect(numbers).toHaveLength(3);
    expect((numbers[1] ?? 0) - (numbers[0] ?? 0)).toBe(1);
    expect((numbers[2] ?? 0) - (numbers[1] ?? 0)).toBe(1);
  });
});

describe('the payments ledger', () => {
  const ledgerGuest = async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    return { guest, bill };
  };

  it('lists payments and refunds newest first, with filters and paging', async () => {
    const { guest, bill } = await ledgerGuest();
    await desk.post(`${BILLS}/${bill.id}/payments`, {
      method: 'upi',
      amountPaise: 80_000,
      reference: 'UPI-77',
    });
    await desk.post(`${BILLS}/${bill.id}/payments`, { method: 'cash', amountPaise: 20_000 });
    await manager.post(`${BILLS}/${bill.id}/refunds`, {
      method: 'cash',
      amountPaise: 5_000,
      reason: 'Correction',
    });

    const all = await desk.get(`${PAYMENTS}?bookingId=${guest.bookingId}&limit=100`);
    expect(all.status).toBe(200);
    const rows = all.body.data as PaymentDto[];
    expect(rows.map((r) => `${r.kind}:${r.method}:${r.amountPaise}`)).toEqual([
      'refund:cash:5000',
      'payment:cash:20000',
      'payment:upi:80000',
    ]);
    expect(rows[2]).toMatchObject({
      reference: 'UPI-77',
      guestName: expect.any(String),
      bookingCode: expect.any(String),
    });

    const upi = await desk.get(`${PAYMENTS}?bookingId=${guest.bookingId}&method=upi`);
    expect((upi.body.data as PaymentDto[]).map((r) => r.amountPaise)).toEqual([80_000]);
    const refunds = await desk.get(`${PAYMENTS}?bookingId=${guest.bookingId}&kind=refund`);
    expect(refunds.body.data as PaymentDto[]).toHaveLength(1);
    const todays = await desk.get(`${PAYMENTS}?bookingId=${guest.bookingId}&date=${today()}`);
    expect(todays.body.data as PaymentDto[]).toHaveLength(3);
    const elsewhere = await desk.get(`${PAYMENTS}?bookingId=${guest.bookingId}&date=${day(-3)}`);
    expect(elsewhere.body.data as PaymentDto[]).toHaveLength(0);
    const page = await desk.get(`${PAYMENTS}?bookingId=${guest.bookingId}&limit=2&page=2`);
    expect(page.body.meta).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(page.body.data).toHaveLength(1);
    expect((await desk.get(`${PAYMENTS}?method=bitcoin`)).status).toBe(400);
    expect((await desk.get(`${PAYMENTS}?limit=1000`)).status).toBe(400);
  });

  it('adds up a day by method: money in, money out and the net', async () => {
    const { bill } = await ledgerGuest();
    await desk.post(`${BILLS}/${bill.id}/payments`, { method: 'cash', amountPaise: 40_000 });
    await manager.post(`${BILLS}/${bill.id}/refunds`, {
      method: 'cash',
      amountPaise: 10_000,
      reason: 'Correction',
    });

    const rows = (await desk.get(`${PAYMENTS}?date=${today()}&limit=100`)).body
      .data as PaymentDto[];
    const collected = rows
      .filter((r) => r.kind === 'payment')
      .reduce((s, r) => s + r.amountPaise, 0);
    const refunded = rows.filter((r) => r.kind === 'refund').reduce((s, r) => s + r.amountPaise, 0);
    const cash = rows
      .filter((r) => r.method === 'cash')
      .reduce((s, r) => s + (r.kind === 'payment' ? r.amountPaise : -r.amountPaise), 0);

    const summary = (await desk.get(`${PAYMENTS}/summary?date=${today()}`)).body
      .data as PaymentsSummaryDto;
    expect(summary).toMatchObject({
      date: today(),
      collectedPaise: collected,
      refundedPaise: refunded,
      netPaise: collected - refunded,
      count: rows.length,
    });
    expect(summary.netByMethod.cash).toBe(cash);
    expect((await desk.get(`${PAYMENTS}/summary`)).status).toBe(400);
  });
});

describe('splitting a discount to get around the approval limit', () => {
  it('counts the discounts already on the bill, so the front desk needs a manager', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    const discount = (amountPaise: number) => ({
      kind: 'discount',
      category: 'other',
      description: 'Goodwill',
      amountPaise,
      reason: 'Guest unhappy',
    });
    const first = await desk.post(`${BILLS}/${bill.id}/lines`, discount(300_000));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await desk.post(`${BILLS}/${bill.id}/lines`, discount(300_000));
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('approval_required');
    expect((await manager.post(`${BILLS}/${bill.id}/lines`, discount(300_000))).status).toBe(201);
  });
});

describe('who may use billing, and keeping properties apart', () => {
  it('keeps kitchen, housekeeping, maintenance and spa staff out of every billing route', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    for (const role of ['kitchen', 'housekeeping', 'maintenance', 'spa_recreation'] as const) {
      const client = await as(a, role);
      expect((await client.get(BILLS)).status, role).toBe(403);
      expect((await client.get(`${BILLS}/${bill.id}`)).status, role).toBe(403);
      expect((await client.get(`${BILLS}/by-booking/${guest.bookingId}`)).status, role).toBe(403);
      expect(
        (await client.post(`${BILLS}/${bill.id}/payments`, { method: 'cash', amountPaise: 100 }))
          .status,
        role,
      ).toBe(403);
      expect((await client.post(`${BILLS}/${bill.id}/finalize`)).status, role).toBe(403);
      expect((await client.get(PAYMENTS)).status, role).toBe(403);
      expect((await client.get(`${PAYMENTS}/summary?date=${today()}`)).status, role).toBe(403);
    }
    expect((await t.anonymous.get(BILLS)).status).toBe(401);
  });

  it('lets the front desk and management work with bills', async () => {
    const guest = await stay();
    for (const role of ['front_desk', 'manager', 'property_admin'] as const) {
      expect(
        (await (await as(a, role)).get(`${BILLS}/by-booking/${guest.bookingId}`)).status,
        role,
      ).toBe(200);
    }
  });

  it('never shows or lets another property touch a bill', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    expect((await otherManager.get(`${BILLS}/${bill.id}`)).status).toBe(404);
    expect((await otherManager.get(`${BILLS}/by-booking/${guest.bookingId}`)).status).toBe(404);
    expect((await otherManager.post(`${BILLS}/${bill.id}/lines`, charge())).status).toBe(404);
    expect(
      (
        await otherManager.post(`${BILLS}/${bill.id}/payments`, {
          method: 'cash',
          amountPaise: 100,
        })
      ).status,
    ).toBe(404);
    expect((await otherManager.post(`${BILLS}/${bill.id}/finalize`)).status).toBe(404);
    const theirList = await otherManager.get(`${BILLS}?limit=100`);
    expect((theirList.body.data as BillSummaryDto[]).some((s) => s.id === bill.id)).toBe(false);
    const theirLedger = await otherManager.get(`${PAYMENTS}?limit=100`);
    expect(theirLedger.body.data).toHaveLength(0);
    expect((await desk.get(`${BILLS}/${bill.id}`)).body.data.status).toBe('open');
  });
});

describe('the billing routes are in the API documentation', () => {
  it('lists them', async () => {
    const res = await request(t.app).get('/openapi.json');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/bills',
        '/api/v1/bills/by-booking/{bookingId}',
        '/api/v1/bills/{id}',
        '/api/v1/bills/{id}/lines',
        '/api/v1/bills/{id}/lines/{lineId}',
        '/api/v1/bills/{id}/payments',
        '/api/v1/bills/{id}/refunds',
        '/api/v1/bills/{id}/finalize',
        '/api/v1/bills/{id}/credit-notes',
        '/api/v1/payments',
        '/api/v1/payments/summary',
      ]),
    );
  });
});
