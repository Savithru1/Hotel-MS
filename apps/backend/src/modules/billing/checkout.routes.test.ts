import type { StaffRole } from '@hospitality/constants';
import type {
  BillDto,
  CheckOutResultDto,
  FacilityDto,
  MenuItemDto,
} from '@hospitality/shared-types';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { day, lookup, today, type Lookup } from '../../../test/fixtures';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { eventBus, type DomainEvent } from '../../shared/events/event-bus';
import { runWithTenant } from '../../shared/request-context';
import { RoomNight } from '../bookings/room-night.model';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { ServiceRequest } from '../service-requests/service-request.model';
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
let kitchen: Client;
let housekeeper: Client;
let spa: Client;
let otherManager: Client;

const BILLS = '/api/v1/bills';
const FY = financialYear(today());
/** Two nights in a Standard room: 2 x (2,500 + 5% tax). */
const TWO_NIGHTS = 525_000;

let chai: MenuItemDto;
let studio: FacilityDto;
let phoneCounter = 0;
let roomCounter = 300;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await as(a, 'manager');
  desk = await as(a, 'front_desk');
  kitchen = await as(a, 'kitchen');
  housekeeper = await as(a, 'housekeeping');
  spa = await as(a, 'spa_recreation');
  otherManager = await as(b, 'manager');
  ids = await lookup(desk);
  for (let n = 301; n <= 360; n++) {
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

afterEach(() => {
  vi.restoreAllMocks();
});

interface Stay {
  bookingId: string;
  room: string;
  roomId: string;
}

async function stay(nights = 2): Promise<Stay> {
  const room = String(++roomCounter);
  const phone = `+9170${String(100_000_000 + ++phoneCounter).slice(1)}`;
  const booked = await desk.post('/api/v1/bookings', {
    guest: { name: `Leaving Guest ${phoneCounter}`, phone },
    roomTypeId: ids.types.Standard,
    roomId: ids.rooms[room],
    checkInDate: day(0),
    checkOutDate: day(nights),
    adults: 1,
  });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const checkedIn = await desk.post(`/api/v1/bookings/${booked.body.data.id}/check-in`, {});
  expect(checkedIn.status, JSON.stringify(checkedIn.body)).toBe(200);
  return { bookingId: booked.body.data.id as string, room, roomId: ids.rooms[room] as string };
}

async function billOf(guest: Stay): Promise<BillDto> {
  const res = await desk.get(`${BILLS}/by-booking/${guest.bookingId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as BillDto;
}

async function settle(guest: Stay): Promise<BillDto> {
  const bill = await billOf(guest);
  if (bill.balancePaise <= 0) return bill;
  const paid = await desk.post(`${BILLS}/${bill.id}/payments`, {
    method: 'cash',
    amountPaise: bill.balancePaise,
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  return paid.body.data as BillDto;
}

const checkOut = (guest: Stay, body: object = {}, client: Client = desk) =>
  client.post(`/api/v1/bookings/${guest.bookingId}/check-out`, body);

async function deliverChai(guest: Stay): Promise<void> {
  const placed = await desk.post('/api/v1/food-orders', {
    roomId: guest.roomId,
    items: [{ menuItemId: chai.id, quantity: 2 }],
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  for (const step of ['start', 'ready', 'deliver']) {
    const res = await kitchen.post(`/api/v1/food-orders/${placed.body.data.id}/${step}`);
    expect(res.status).toBe(200);
  }
}

const roomStatus = async (guest: Stay): Promise<string> =>
  (await desk.get(`/api/v1/rooms/${guest.roomId}`)).body.data.status as string;

const bookingStatus = async (guest: Stay): Promise<string> =>
  (await desk.get(`/api/v1/bookings/${guest.bookingId}`)).body.data.status as string;

const invoiceSeq = async (): Promise<number> =>
  (await runWithTenant(a.id, () => Counter.findOne({ key: `invoice:${FY}` }).lean()))?.seq ?? 0;

const cleaningTasks = (guest: Stay) =>
  runWithTenant(a.id, () => ServiceRequest.find({ roomId: guest.roomId }).lean());

const nightsHeld = (guest: Stay) =>
  runWithTenant(a.id, () => RoomNight.countDocuments({ bookingId: guest.bookingId }));

describe('checking a guest out', () => {
  it('issues the invoice, frees the room for cleaning and finishes the stay in one step', async () => {
    const guest = await stay();
    await settle(guest);
    const seqBefore = await invoiceSeq();

    const res = await checkOut(guest);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const done = res.body.data as CheckOutResultDto;
    expect(done).toMatchObject({
      bookingId: guest.bookingId,
      roomNumber: guest.room,
      status: 'checked_out',
    });
    expect(new Date(done.checkedOutAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(done.bill.status).toBe('finalized');
    expect(done.bill.invoice?.number).toBe(`INV/${FY}/${String(seqBefore + 1).padStart(6, '0')}`);
    expect(done.bill.totals.totalPaise).toBe(TWO_NIGHTS);
    expect(done.bill.balancePaise).toBe(0);

    expect(await bookingStatus(guest)).toBe('checked_out');
    expect(await roomStatus(guest)).toBe('cleaning');
    const tasks = await cleaningTasks(guest);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ type: 'room_cleaning', status: 'new', source: 'system' });
  });

  it('puts the nights the guest did not use back on sale', async () => {
    const guest = await stay(3);
    expect(await nightsHeld(guest)).toBe(3);
    await settle(guest);
    expect((await checkOut(guest)).status).toBe(200);
    expect(await nightsHeld(guest)).toBe(0);

    // The room can be booked again for the nights that were released.
    const again = await desk.post('/api/v1/bookings', {
      guest: { name: 'Next Guest', phone: '+917099990001' },
      roomTypeId: ids.types.Standard,
      roomId: guest.roomId,
      checkInDate: day(1),
      checkOutDate: day(2),
      adults: 1,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it('includes delivered food in the invoice', async () => {
    const guest = await stay();
    await deliverChai(guest);
    await settle(guest);
    const res = await checkOut(guest);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bill = res.body.data.bill as BillDto;
    expect(bill.lines.map((line) => line.kind).sort()).toEqual(['food', 'room', 'room']);
    expect(bill.totals.totalPaise).toBe(TWO_NIGHTS + 16_800);
  });

  it('keeps the invoice number when the bill was already finalized', async () => {
    const guest = await stay();
    await settle(guest);
    const bill = await billOf(guest);
    const finalized = await desk.post(`${BILLS}/${bill.id}/finalize`);
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
    const number = finalized.body.data.invoice.number as string;
    const seq = await invoiceSeq();

    const res = await checkOut(guest);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.bill.invoice.number).toBe(number);
    expect(await invoiceSeq()).toBe(seq);
  });

  it('writes one audit entry that names the invoice', async () => {
    const guest = await stay();
    await settle(guest);
    const res = await checkOut(guest);
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'booking.checked_out', 'target.id': guest.bookingId }).lean(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.summary).toMatchObject({
      invoiceNumber: res.body.data.bill.invoice.number,
      balancePaise: 0,
      overrideReason: null,
    });
  });

  it('tells the front desk and housekeeping once it has happened', async () => {
    const guest = await stay();
    await settle(guest);
    const seen: DomainEvent[] = [];
    const stop = eventBus.subscribe((event) => seen.push(event));
    try {
      expect((await checkOut(guest)).status).toBe(200);
    } finally {
      stop();
    }
    const types = seen.map((event) => event.type);
    expect(types).toContain('booking.changed');
    expect(types).toContain('room.status_changed');
    expect(types).toContain('housekeeping.changed');
    const room = seen.find((event) => event.type === 'room.status_changed');
    expect(room?.data).toMatchObject({
      roomNumber: guest.room,
      status: 'cleaning',
      previous: 'occupied',
    });
  });
});

describe('an unsettled balance', () => {
  it('refuses check-out and leaves everything exactly as it was', async () => {
    const guest = await stay();
    const seqBefore = await invoiceSeq();

    const res = await checkOut(guest);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('unpaid_balance');
    expect(res.body.error.details).toMatchObject({ balancePaise: TWO_NIGHTS });

    expect(await bookingStatus(guest)).toBe('checked_in');
    expect(await roomStatus(guest)).toBe('occupied');
    expect(await cleaningTasks(guest)).toHaveLength(0);
    expect(await nightsHeld(guest)).toBe(2);
    const bill = await runWithTenant(a.id, () =>
      Bill.findOne({ bookingId: guest.bookingId }).lean(),
    );
    expect(bill?.status).toBe('open');
    expect(bill?.invoice ?? null).toBeNull();
    // The invoice number that was reserved inside the transaction is given back.
    expect(await invoiceSeq()).toBe(seqBefore);
  });

  it('refuses a part payment too', async () => {
    const guest = await stay();
    const bill = await billOf(guest);
    await desk.post(`${BILLS}/${bill.id}/payments`, { method: 'upi', amountPaise: 100_000 });
    const res = await checkOut(guest);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ balancePaise: TWO_NIGHTS - 100_000 });
  });

  it('lets a manager check the guest out with a reason, and records it', async () => {
    const guest = await stay();
    const res = await checkOut(
      guest,
      { overrideReason: 'Company will settle the account' },
      manager,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.bill.status).toBe('finalized');
    expect(res.body.data.bill.balancePaise).toBe(TWO_NIGHTS);
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'booking.checked_out', 'target.id': guest.bookingId }).lean(),
    );
    expect(audits[0]?.summary).toMatchObject({
      overrideReason: 'Company will settle the account',
      balancePaise: TWO_NIGHTS,
    });
  });

  it('does not let the front desk use the manager override', async () => {
    const guest = await stay();
    const res = await checkOut(guest, { overrideReason: 'Guest is a friend of the owner' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('manager_override_required');
    expect(await bookingStatus(guest)).toBe('checked_in');
  });

  it('asks for a refund first when the guest has paid more than the bill', async () => {
    const guest = await stay();
    const paid = await settle(guest);
    // A discount after payment leaves the guest owed money.
    const discount = await desk.post(`${BILLS}/${paid.id}/lines`, {
      kind: 'discount',
      category: 'other',
      description: 'Goodwill',
      amountPaise: 10_000,
      reason: 'Noisy neighbours',
    });
    expect(discount.status, JSON.stringify(discount.body)).toBe(201);

    const refused = await checkOut(guest);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('refund_due');
    expect(refused.body.error.details.balancePaise).toBeLessThan(0);

    const owed = -refused.body.error.details.balancePaise;
    const refund = await manager.post(`${BILLS}/${paid.id}/refunds`, {
      method: 'cash',
      amountPaise: owed,
      reason: 'Goodwill discount',
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect((await checkOut(guest)).status).toBe(200);
  });
});

describe('things still open', () => {
  it('will not check out while a food order is open', async () => {
    const guest = await stay();
    await settle(guest);
    const placed = await desk.post('/api/v1/food-orders', {
      roomId: guest.roomId,
      items: [{ menuItemId: chai.id, quantity: 1 }],
    });
    expect(placed.status).toBe(201);
    const res = await checkOut(guest);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('open_items');
    expect(await bookingStatus(guest)).toBe('checked_in');
  });

  it('will not check out while a facility booking is open', async () => {
    const guest = await stay();
    await settle(guest);
    const booked = await spa.post('/api/v1/facility-bookings', {
      facilityId: studio.id,
      roomId: guest.roomId,
      date: day(1),
      startTime: '10:00',
      participants: 1,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const res = await checkOut(guest);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('open_items');
  });

  it('refuses new orders and bookings once the invoice is issued, so check-out is never stuck', async () => {
    const guest = await stay();
    await settle(guest);
    const bill = await billOf(guest);
    expect((await desk.post(`${BILLS}/${bill.id}/finalize`)).status).toBe(200);

    const order = await desk.post('/api/v1/food-orders', {
      roomId: guest.roomId,
      items: [{ menuItemId: chai.id, quantity: 1 }],
    });
    expect(order.status).toBe(409);
    expect(order.body.error.code).toBe('invoice_issued');

    const session = await spa.post('/api/v1/facility-bookings', {
      facilityId: studio.id,
      roomId: guest.roomId,
      date: day(1),
      startTime: '10:00',
      participants: 1,
    });
    expect(session.status).toBe(409);
    expect(session.body.error.code).toBe('invoice_issued');

    // Nothing can slip in after the invoice, so check-out goes through.
    expect((await checkOut(guest)).status).toBe(200);
  });
});

describe('check-out under pressure', () => {
  it('lets exactly one of two simultaneous check-outs win', async () => {
    const guest = await stay();
    await settle(guest);
    const seqBefore = await invoiceSeq();

    const results = await Promise.all([checkOut(guest), checkOut(guest)]);
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await invoiceSeq()).toBe(seqBefore + 1);
    expect(await cleaningTasks(guest)).toHaveLength(1);
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'booking.checked_out', 'target.id': guest.bookingId }).lean(),
    );
    expect(audits).toHaveLength(1);
  });

  it('rolls everything back when the cleaning task cannot be created', async () => {
    const guest = await stay();
    await settle(guest);
    const seqBefore = await invoiceSeq();
    vi.spyOn(ServiceRequest, 'create').mockRejectedValueOnce(new Error('disk full'));

    const res = await checkOut(guest);
    expect(res.status).toBe(500);

    expect(await bookingStatus(guest)).toBe('checked_in');
    expect(await roomStatus(guest)).toBe('occupied');
    expect(await nightsHeld(guest)).toBe(2);
    const bill = await runWithTenant(a.id, () =>
      Bill.findOne({ bookingId: guest.bookingId }).lean(),
    );
    expect(bill?.status).toBe('open');
    expect(await invoiceSeq()).toBe(seqBefore);

    // Nothing is stuck: trying again works.
    expect((await checkOut(guest)).status).toBe(200);
  });

  it('rolls back when the audit entry cannot be written', async () => {
    const guest = await stay();
    await settle(guest);
    const seqBefore = await invoiceSeq();
    const original = AuditLog.create.bind(AuditLog);
    vi.spyOn(AuditLog, 'create').mockImplementation(((docs: unknown, ...rest: unknown[]) => {
      const first = Array.isArray(docs) ? docs[0] : docs;
      if ((first as { action?: string } | undefined)?.action === 'booking.checked_out') {
        return Promise.reject(new Error('audit down'));
      }
      return (original as (...args: unknown[]) => unknown)(docs, ...rest);
    }) as never);

    const res = await checkOut(guest);
    expect(res.status).toBe(500);
    expect(await bookingStatus(guest)).toBe('checked_in');
    expect(await invoiceSeq()).toBe(seqBefore);
  });
});

describe('who may check a guest out', () => {
  it('is the front desk and management only', async () => {
    const guest = await stay();
    for (const client of [kitchen, housekeeper, spa]) {
      expect((await checkOut(guest, {}, client)).status).toBe(403);
    }
    expect(
      (await t.anonymous.post(`/api/v1/bookings/${guest.bookingId}/check-out`, {})).status,
    ).toBe(401);
    expect(await bookingStatus(guest)).toBe('checked_in');
  });

  it('answers clearly for a guest who is not checked in, has left, or does not exist', async () => {
    const waiting = await desk.post('/api/v1/bookings', {
      guest: { name: 'Not Here Yet', phone: '+917099990002' },
      roomTypeId: ids.types.Standard,
      roomId: ids.rooms[String(++roomCounter)],
      checkInDate: day(1),
      checkOutDate: day(2),
      adults: 1,
    });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(201);
    const early = await desk.post(`/api/v1/bookings/${waiting.body.data.id}/check-out`, {});
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('not_checked_in');

    const guest = await stay();
    await settle(guest);
    expect((await checkOut(guest)).status).toBe(200);
    const twice = await checkOut(guest);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('already_checked_out');

    const missing = await desk.post('/api/v1/bookings/64b64b64b64b64b64b64b64b/check-out', {});
    expect(missing.status).toBe(404);
    expect((await desk.post('/api/v1/bookings/not-an-id/check-out', {})).status).toBe(400);
  });

  it('never lets another property check a guest out', async () => {
    const guest = await stay();
    await settle(guest);
    const res = await checkOut(guest, {}, otherManager);
    expect(res.status).toBe(404);
    expect(await bookingStatus(guest)).toBe('checked_in');
  });

  it('rejects an override reason that is too short', async () => {
    const guest = await stay();
    const res = await checkOut(guest, { overrideReason: 'x' }, manager);
    expect(res.status).toBe(400);
  });
});
