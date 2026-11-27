import {
  FACILITY_HOLDING_STATUSES,
  FOOD_ORDER_OPEN_STATUSES,
  MANUAL_APPROVAL_LIMIT_PAISE,
  isManagementRole,
  type BillStatus,
  type ManualLineCategory,
  type PaymentMethod,
} from '@hospitality/constants';
import type { BillDto, BillSummaryDto } from '@hospitality/shared-types';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import { recordAudit } from '../../shared/audit/audit';
import { nightsOf, todayIn } from '../../shared/dates';
import { HttpError, conflict, forbidden, notFound } from '../../shared/errors';
import { getTenantId } from '../../shared/request-context';
import { inTransaction } from '../../shared/transaction';
import type { AuthenticatedStaff } from '../auth/auth.types';
import { Booking, type BookingDocument } from '../bookings/booking.model';
import { FacilityBooking } from '../facilities/facility-booking.model';
import { FoodOrder } from '../food-orders/food-order.model';
import type { PropertyService } from '../properties/property.service';
import { Room } from '../rooms/room.model';
import { Guest } from '../users/guest.model';
import { Bill, type BillDocument, type BillLineDocument } from './bill.model';
import { buildBillLine, type BillLineInput } from './bill-line';
import { Counter } from './counter.model';
import { CreditNote, type CreditNoteDocument } from './credit-note.model';
import { financialYear, gstinStateName, isIntraState, summarise, type TaxContext } from './gst';
import { balanceOf, isManualLine, toBillDto, toBillSummary, totalsOf } from './billing.mapper';
import { Payment, type PaymentDocument } from './payment.model';
import { createPaymentLedger, type PaymentLedger } from './payment-ledger';

export interface AddLineInput {
  kind: 'charge' | 'discount';
  category: ManualLineCategory;
  description: string;
  amountPaise: number;
  quantity: number;
  reason: string;
}

export interface PaymentInput {
  method: PaymentMethod;
  amountPaise: number;
  reference: string;
}

export interface RefundInput {
  method: PaymentMethod;
  amountPaise: number;
  reason: string;
}

export interface ListBillsInput {
  page: number;
  limit: number;
  status?: BillStatus | undefined;
  bookingId?: string | undefined;
}

export type { ListPaymentsInput } from './payment-ledger';

/** What one pass of `syncOpenBills` did: bills brought up to date, and the bookings that failed. */
export interface SyncOpenResult {
  synced: number;
  failures: { bookingId: string; error: unknown }[];
}

export interface BillingService extends PaymentLedger {
  /**
   * Opens the bill of every checked-in guest of the current property and posts what is missing.
   * Safe to run again and again. A booking that fails is reported and the rest carry on.
   */
  syncOpenBills(): Promise<SyncOpenResult>;
  /** Opens the bill of a checked-in guest if there is none, brings it up to date, and returns it. */
  forBooking(bookingId: string): Promise<BillDto>;
  get(id: string): Promise<BillDto>;
  list(input: ListBillsInput): Promise<{ items: BillSummaryDto[]; total: number }>;
  addLine(actor: AuthenticatedStaff, id: string, input: AddLineInput): Promise<BillDto>;
  removeLine(actor: AuthenticatedStaff, id: string, lineId: string): Promise<BillDto>;
  recordPayment(actor: AuthenticatedStaff, id: string, input: PaymentInput): Promise<BillDto>;
  refund(actor: AuthenticatedStaff, id: string, input: RefundInput): Promise<BillDto>;
  finalize(actor: AuthenticatedStaff, id: string): Promise<BillDto>;
  creditNote(
    actor: AuthenticatedStaff,
    id: string,
    input: { lineId: string; reason: string },
  ): Promise<BillDto>;

  // Used by check-out, which runs these inside its own transaction.
  /** Makes sure a bill exists for the booking. Call before opening a transaction. */
  ensureBill(booking: BookingDocument): Promise<BillDocument>;
  /** Makes sure the invoice counter for today's financial year exists. Call before a transaction. */
  prepareInvoiceCounter(): Promise<void>;
  /** The open food orders and facility bookings of a booking, as a readable problem or null. */
  openItemsProblem(bookingId: Types.ObjectId): Promise<string | null>;
  /** Delivered orders and completed facility bookings that are not on the bill. */
  unbilledItemCount(bill: BillDocument, booking: BookingDocument): Promise<number>;
  /** Finalizes (if still open) and returns the bill with its balance, inside the caller's transaction. */
  finalizeForCheckout(
    session: ClientSession,
    actor: AuthenticatedStaff,
    booking: BookingDocument,
  ): Promise<{ bill: BillDocument; balancePaise: number }>;
  assemble(bill: BillDocument): Promise<BillDto>;
}

const OPEN_FOOD = [...FOOD_ORDER_OPEN_STATUSES];
const HOLDING = [...FACILITY_HOLDING_STATUSES];
const SYNC_ATTEMPTS = 4;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

const isManager = (actor: AuthenticatedStaff): boolean =>
  isManagementRole(actor.role) || actor.role === 'platform_admin';

const pad = (seq: number): string => String(seq).padStart(6, '0');

export function createBillingService(properties: PropertyService): BillingService {
  const tenant = (): Types.ObjectId => {
    const id = getTenantId();
    if (!id) throw new Error('No tenant context');
    return id;
  };
  const property = () => properties.get(tenant());

  async function loadBill(id: string, session?: ClientSession): Promise<BillDocument> {
    const bill = await Bill.findOne({ _id: id })
      .session(session ?? null)
      .lean();
    if (!bill) throw notFound('Bill not found');
    return bill;
  }

  async function loadBooking(id: Types.ObjectId | string): Promise<BookingDocument> {
    const booking = await Booking.findOne({ _id: id }).lean();
    if (!booking) throw notFound('Booking not found');
    return booking;
  }

  async function audit(
    action: string,
    bill: BillDocument,
    extra: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<void> {
    await recordAudit({
      action: `bill.${action}`,
      target: { type: 'bill', id: bill._id.toHexString() },
      summary: { bookingCode: bill.bookingCode, ...extra },
      ...(session ? { session } : {}),
    });
  }

  async function assemble(bill: BillDocument): Promise<BillDto> {
    const [payments, notes] = await Promise.all([
      Payment.find({ billId: bill._id }).sort({ createdAt: 1, _id: 1 }).lean(),
      CreditNote.find({ billId: bill._id }).sort({ createdAt: 1, _id: 1 }).lean(),
    ]);
    return toBillDto(bill, payments, notes);
  }

  async function ensureBill(booking: BookingDocument): Promise<BillDocument> {
    const existing = await Bill.findOne({ bookingId: booking._id }).lean();
    if (existing) return existing;
    if (!['checked_in', 'checked_out'].includes(booking.status)) {
      throw conflict('The guest has not checked in yet, so there is no bill', 'not_checked_in');
    }
    const [guest, room, prop] = await Promise.all([
      Guest.findOne({ _id: booking.guestId }).lean(),
      Room.findOne({ _id: booking.roomId }, { number: 1 }).lean(),
      property(),
    ]);
    if (!room) throw notFound('The room of this booking no longer exists');
    const gstin = guest?.gstin ?? null;
    const supplyState = gstinStateName(gstin);
    try {
      const [created] = await Bill.create([
        {
          bookingId: booking._id,
          bookingCode: booking.bookingCode,
          guestName: booking.guestSnapshot.name,
          guestPhone: booking.guestSnapshot.phone,
          guestGstin: gstin,
          placeOfSupplyState: supplyState,
          intraState: isIntraState(prop.stateName, supplyState),
          roomNumber: room.number,
          nightlyRatePaise: booking.nightlyRatePaise,
          checkInDate: booking.checkInDate,
          checkOutDate: booking.checkOutDate,
        },
      ]);
      if (!created) throw new Error('Bill was not created');
      return created.toObject();
    } catch (error) {
      // Two requests opened the bill at the same moment: the other one won, use its bill.
      if (!isDuplicateKey(error)) throw error;
      const winner = await Bill.findOne({ bookingId: booking._id }).lean();
      if (!winner) throw error;
      return winner;
    }
  }

  /** Builds one line, taxed under the rules in force on the day of the service. */
  const buildLine = (bill: BillDocument, context: TaxContext, input: BillLineInput) =>
    buildBillLine(bill.nightlyRatePaise, context, input);

  /** Every line the bill should have right now, from the stay, delivered orders and completed bookings. */
  async function desiredLines(
    bill: BillDocument,
    booking: BookingDocument,
    session?: ClientSession,
  ): Promise<BillLineDocument[]> {
    const prop = await property();
    const context: TaxContext = { rules: prop.gstRules, intraState: bill.intraState };
    const lines: BillLineDocument[] = [];

    for (const date of nightsOf(booking.checkInDate, booking.checkOutDate)) {
      lines.push(
        buildLine(bill, context, {
          sourceKey: `room:${date}`,
          kind: 'room',
          category: 'room',
          description: `Room ${bill.roomNumber} · night of ${date}`,
          serviceDate: date,
          quantity: 1,
          unitPaise: booking.nightlyRatePaise,
          taxablePaise: booking.nightlyRatePaise,
        }),
      );
    }

    const orders = await FoodOrder.find({ bookingId: booking._id, status: 'delivered' })
      .session(session ?? null)
      .sort({ deliveredAt: 1, _id: 1 })
      .lean();
    for (const order of orders) {
      lines.push(
        buildLine(bill, context, {
          sourceKey: `food:${order._id.toHexString()}`,
          kind: 'food',
          category: 'food',
          description: `Food order ${order.code}`,
          serviceDate: todayIn(prop.timezone, order.deliveredAt ?? order.createdAt),
          quantity: 1,
          unitPaise: order.subtotalPaise,
          taxablePaise: order.subtotalPaise,
        }),
      );
    }

    const sessions = await FacilityBooking.find({ bookingId: booking._id, status: 'completed' })
      .session(session ?? null)
      .sort({ slotStart: 1, _id: 1 })
      .lean();
    for (const item of sessions) {
      lines.push(
        buildLine(bill, context, {
          sourceKey: `facility:${item._id.toHexString()}`,
          kind: 'facility',
          category: 'spa_recreation',
          description: `${item.facilityName} · ${item.date} ${item.startTime} × ${item.participants}`,
          serviceDate: item.date,
          quantity: 1,
          unitPaise: item.totalPaise,
          taxablePaise: item.totalPaise,
        }),
      );
    }
    return lines;
  }

  /**
   * Brings an open bill up to date: posts nights, delivered orders and completed bookings that are
   * not on it yet, and drops room nights that are no longer part of the stay. Safe to run again and
   * again, even at the same moment from several requests, because a line is only ever added when
   * none of the lines being added is already there.
   */
  async function syncCharges(
    bill: BillDocument,
    booking: BookingDocument,
    session?: ClientSession,
  ): Promise<BillDocument> {
    if (bill.status !== 'open') return bill;
    // The stay may have been shortened or extended since the bill was opened.
    if (bill.checkInDate !== booking.checkInDate || bill.checkOutDate !== booking.checkOutDate) {
      await Bill.updateOne(
        { _id: bill._id, status: 'open' },
        { $set: { checkInDate: booking.checkInDate, checkOutDate: booking.checkOutDate } },
        session ? { session } : {},
      );
    }
    const desired = await desiredLines(bill, booking, session);
    const wanted = new Set(desired.map((line) => line.sourceKey));

    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
      const current = await loadBill(bill._id.toHexString(), session);
      if (current.status !== 'open') return current;
      const have = new Set(current.lines.map((line) => line.sourceKey));
      const missing = desired.filter((line) => !have.has(line.sourceKey));
      const stale = current.lines
        .filter((line) => line.sourceKey.startsWith('room:') && !wanted.has(line.sourceKey))
        .map((line) => line.sourceKey);
      if (missing.length === 0 && stale.length === 0) return current;

      if (stale.length > 0) {
        await Bill.updateOne(
          { _id: current._id, status: 'open' },
          { $pull: { lines: { sourceKey: { $in: stale } } } },
          session ? { session } : {},
        );
      }
      if (missing.length > 0) {
        const missingKeys = missing.map((line) => line.sourceKey);
        const result = await Bill.updateOne(
          {
            _id: current._id,
            status: 'open',
            lines: { $not: { $elemMatch: { sourceKey: { $in: missingKeys } } } },
          },
          { $push: { lines: { $each: missing } } },
          session ? { session } : {},
        );
        // Someone else added some of them first: look again and add only what is still missing.
        if (result.modifiedCount === 0) continue;
      }
    }
    return loadBill(bill._id.toHexString(), session);
  }

  async function refreshed(bill: BillDocument): Promise<BillDocument> {
    if (bill.status !== 'open') return bill;
    return syncCharges(bill, await loadBooking(bill.bookingId));
  }

  async function paymentsOf(
    billId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<PaymentDocument[]> {
    return Payment.find({ billId })
      .session(session ?? null)
      .lean();
  }
  async function creditNotesOf(
    billId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<CreditNoteDocument[]> {
    return CreditNote.find({ billId })
      .session(session ?? null)
      .lean();
  }

  async function currentBalance(bill: BillDocument, session?: ClientSession) {
    const [payments, notes] = await Promise.all([
      paymentsOf(bill._id, session),
      creditNotesOf(bill._id, session),
    ]);
    return balanceOf(totalsOf(bill), payments, notes);
  }

  async function openItemsProblem(bookingId: Types.ObjectId): Promise<string | null> {
    const [orders, sessions] = await Promise.all([
      FoodOrder.countDocuments({ bookingId, status: { $in: OPEN_FOOD } }),
      FacilityBooking.countDocuments({ bookingId, status: { $in: HOLDING } }),
    ]);
    if (orders === 0 && sessions === 0) return null;
    const parts = [
      orders > 0 ? `${orders} food ${orders === 1 ? 'order' : 'orders'}` : null,
      sessions > 0 ? `${sessions} facility ${sessions === 1 ? 'booking' : 'bookings'}` : null,
    ].filter(Boolean);
    return `This guest still has ${parts.join(' and ')} open. Deliver, finish or cancel them first.`;
  }

  async function unbilledItemCount(bill: BillDocument, booking: BookingDocument): Promise<number> {
    const have = new Set(bill.lines.map((line) => line.sourceKey));
    const [orders, sessions] = await Promise.all([
      FoodOrder.find({ bookingId: booking._id, status: 'delivered' }, { _id: 1 }).lean(),
      FacilityBooking.find({ bookingId: booking._id, status: 'completed' }, { _id: 1 }).lean(),
    ]);
    return (
      orders.filter((order) => !have.has(`food:${order._id.toHexString()}`)).length +
      sessions.filter((item) => !have.has(`facility:${item._id.toHexString()}`)).length
    );
  }

  async function prepareInvoiceCounter(): Promise<void> {
    const prop = await property();
    await ensureCounter(`invoice:${financialYear(todayIn(prop.timezone))}`);
  }

  /** The counter has to exist before a transaction uses it, so two first uses cannot collide. */
  async function ensureCounter(key: string): Promise<void> {
    await Counter.updateOne({ key }, { $setOnInsert: { key, seq: 0 } }, { upsert: true });
  }

  async function nextNumber(session: ClientSession, key: string): Promise<number> {
    const counter = await Counter.findOneAndUpdate(
      { key },
      { $inc: { seq: 1 } },
      { session, returnDocument: 'after' },
    ).lean();
    if (!counter) throw new Error(`Counter ${key} is missing`);
    return counter.seq;
  }

  /** Marks a bill as touched by a money change, so two such changes at once take turns. */
  async function bump(
    session: ClientSession,
    id: Types.ObjectId,
    status: BillStatus | null,
  ): Promise<BillDocument | null> {
    return Bill.findOneAndUpdate(
      { _id: id, ...(status ? { status } : {}) },
      { $inc: { rev: 1 } },
      { session, returnDocument: 'after' },
    ).lean();
  }

  async function finalizeInSession(
    session: ClientSession,
    actor: AuthenticatedStaff,
    billId: Types.ObjectId,
    booking: BookingDocument,
  ): Promise<BillDocument> {
    const bumped = await bump(session, billId, 'open');
    if (!bumped) throw conflict('This bill is already finalized', 'already_finalized');
    const synced = await syncCharges(bumped, booking, session);
    if (synced.lines.length === 0) throw conflict('There is nothing on this bill', 'empty_bill');

    const prop = await property();
    const issuedOn = todayIn(prop.timezone);
    const year = financialYear(issuedOn);
    const seq = await nextNumber(session, `invoice:${year}`);
    const number = `INV/${year}/${pad(seq)}`;
    const totals = summarise(synced.lines);
    const address = [
      prop.address.line1,
      prop.address.line2,
      prop.address.city,
      prop.address.state,
      prop.address.pincode,
    ]
      .filter(Boolean)
      .join(', ');

    const updated = await Bill.findOneAndUpdate(
      { _id: billId, status: 'open' },
      {
        $set: {
          status: 'finalized',
          finalizedAt: new Date(),
          invoice: {
            number,
            financialYear: year,
            issuedAt: new Date(),
            supplier: {
              legalName: prop.legalName || prop.name,
              gstin: prop.gstin,
              stateName: prop.stateName,
              address,
            },
            placeOfSupplyState: synced.placeOfSupplyState ?? prop.stateName,
            intraState: synced.intraState,
            totals,
          },
        },
      },
      { session, returnDocument: 'after' },
    ).lean();
    if (!updated) throw conflict('This bill is already finalized', 'already_finalized');
    await audit(
      'finalized',
      updated,
      {
        invoiceNumber: number,
        totalPaise: totals.totalPaise,
        lines: updated.lines.length,
        by: actor.id.toHexString(),
      },
      session,
    );
    return updated;
  }

  /**
   * A manager is needed above the limit. `alreadyPaise` is what the same kind of line has already
   * taken off the bill, so a discount cannot be split into many small ones to get under the limit.
   */
  const assertManualApproval = (
    actor: AuthenticatedStaff,
    taxablePaise: number,
    alreadyPaise = 0,
  ): boolean => {
    const needsManager = Math.abs(taxablePaise) + alreadyPaise > MANUAL_APPROVAL_LIMIT_PAISE;
    if (needsManager && !isManager(actor)) {
      throw forbidden('This amount needs a manager to approve it', 'approval_required');
    }
    return needsManager;
  };

  return {
    ensureBill,
    prepareInvoiceCounter,
    openItemsProblem,
    unbilledItemCount,
    assemble,

    async syncOpenBills() {
      const bookings = await Booking.find({ status: 'checked_in' }).sort({ _id: 1 }).lean();
      let synced = 0;
      const failures: SyncOpenResult['failures'] = [];
      for (const booking of bookings) {
        try {
          await syncCharges(await ensureBill(booking), booking);
          synced += 1;
        } catch (error) {
          failures.push({ bookingId: booking._id.toHexString(), error });
        }
      }
      return { synced, failures };
    },

    async forBooking(bookingId) {
      const booking = await loadBooking(bookingId);
      const bill = await ensureBill(booking);
      return assemble(await syncCharges(bill, booking));
    },

    async get(id) {
      return assemble(await refreshed(await loadBill(id)));
    },

    async list(input) {
      const filter: Record<string, unknown> = {};
      if (input.status) filter.status = input.status;
      if (input.bookingId) filter.bookingId = input.bookingId;
      const [bills, total] = await Promise.all([
        Bill.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean(),
        Bill.countDocuments(filter),
      ]);
      const items = await Promise.all(
        bills.map(async (bill) => toBillSummary(bill, await currentBalance(bill))),
      );
      return { items, total };
    },

    async addLine(actor, id, input) {
      const bill = await refreshed(await loadBill(id));
      if (bill.status !== 'open') throw conflict('This bill is finalized', 'bill_finalized');
      const taxable = (input.kind === 'discount' ? -1 : 1) * input.amountPaise * input.quantity;
      const discountsSoFar = bill.lines
        .filter((existing) => existing.kind === 'discount')
        .reduce((sum, existing) => sum - existing.taxablePaise, 0);
      const approved = assertManualApproval(
        actor,
        taxable,
        input.kind === 'discount' ? discountsSoFar : 0,
      );

      const prop = await property();
      const line = buildLine(
        bill,
        { rules: prop.gstRules, intraState: bill.intraState },
        {
          sourceKey: `manual:${randomUUID()}`,
          kind: input.kind,
          category: input.category,
          description: input.description,
          serviceDate: todayIn(prop.timezone),
          quantity: input.quantity,
          unitPaise: input.amountPaise,
          taxablePaise: taxable,
          reason: input.reason,
          addedBy: actor.name,
          approvedBy: approved ? actor.name : null,
        },
      );
      const updated = await inTransaction(async (session) => {
        const changed = await Bill.findOneAndUpdate(
          { _id: bill._id, status: 'open' },
          { $inc: { rev: 1 }, $push: { lines: line } },
          { session, returnDocument: 'after' },
        ).lean();
        if (!changed) throw conflict('This bill is finalized', 'bill_finalized');
        await audit(
          'line_added',
          changed,
          {
            kind: input.kind,
            category: input.category,
            description: input.description,
            taxablePaise: taxable,
            taxPaise: line.taxPaise,
            reason: input.reason,
            approvedByManager: approved,
          },
          session,
        );
        return changed;
      });
      return assemble(updated);
    },

    async removeLine(actor, id, lineId) {
      const bill = await loadBill(id);
      if (bill.status !== 'open') throw conflict('This bill is finalized', 'bill_finalized');
      const line = bill.lines.find((candidate) => candidate.lineId === lineId);
      if (!line) throw new HttpError(404, 'line_not_found', 'That line is not on this bill');
      if (!isManualLine(line)) {
        throw conflict(
          'Only a charge or discount added by hand can be removed. Room, food and facility lines follow the stay.',
          'not_manual',
        );
      }
      assertManualApproval(actor, line.taxablePaise);

      const updated = await inTransaction(async (session) => {
        const changed = await Bill.findOneAndUpdate(
          { _id: bill._id, status: 'open', 'lines.lineId': lineId },
          { $inc: { rev: 1 }, $pull: { lines: { lineId } } },
          { session, returnDocument: 'after' },
        ).lean();
        if (!changed)
          throw conflict('That line was already removed or the bill changed', 'conflict');
        await audit(
          'line_removed',
          changed,
          {
            description: line.description,
            taxablePaise: line.taxablePaise,
            by: actor.id.toHexString(),
          },
          session,
        );
        return changed;
      });
      return assemble(updated);
    },

    async recordPayment(actor, id, input) {
      const bill = await refreshed(await loadBill(id));
      const booking = { bookingId: bill.bookingId };
      const updated = await inTransaction(async (session) => {
        // Taking the bill's revision first makes two payments at once take turns, so the second
        // one sees the first and cannot push the total over what is owed.
        const fresh = await bump(session, bill._id, null);
        if (!fresh) throw notFound('Bill not found');
        const { balancePaise } = await currentBalance(fresh, session);
        if (input.amountPaise > balancePaise) {
          throw conflict(
            balancePaise > 0
              ? `That is more than the balance of ${balancePaise} paise`
              : 'Nothing is owed on this bill',
            'overpayment',
            { balancePaise: Math.max(0, balancePaise) },
          );
        }
        await Payment.create(
          [
            {
              billId: fresh._id,
              bookingId: booking.bookingId,
              bookingCode: fresh.bookingCode,
              guestName: fresh.guestName,
              kind: 'payment',
              method: input.method,
              amountPaise: input.amountPaise,
              reference: input.reference,
              recordedBy: actor.name,
            },
          ],
          { session },
        );
        await audit(
          'payment_recorded',
          fresh,
          { method: input.method, amountPaise: input.amountPaise, reference: input.reference },
          session,
        );
        return fresh;
      });
      return assemble(updated);
    },

    async refund(actor, id, input) {
      const bill = await loadBill(id);
      const updated = await inTransaction(async (session) => {
        const fresh = await bump(session, bill._id, null);
        if (!fresh) throw notFound('Bill not found');
        const { paidPaise, refundedPaise } = await currentBalance(fresh, session);
        if (input.amountPaise > paidPaise - refundedPaise) {
          throw conflict(
            'That is more than has been paid and not yet refunded',
            'refund_too_large',
            {
              refundablePaise: Math.max(0, paidPaise - refundedPaise),
            },
          );
        }
        await Payment.create(
          [
            {
              billId: fresh._id,
              bookingId: fresh.bookingId,
              bookingCode: fresh.bookingCode,
              guestName: fresh.guestName,
              kind: 'refund',
              method: input.method,
              amountPaise: input.amountPaise,
              reason: input.reason,
              recordedBy: actor.name,
            },
          ],
          { session },
        );
        await audit(
          'refund_recorded',
          fresh,
          { method: input.method, amountPaise: input.amountPaise, reason: input.reason },
          session,
        );
        return fresh;
      });
      return assemble(updated);
    },

    async finalize(actor, id) {
      const bill = await loadBill(id);
      if (bill.status !== 'open')
        throw conflict('This bill is already finalized', 'already_finalized');
      const booking = await loadBooking(bill.bookingId);
      if (!['checked_in', 'checked_out'].includes(booking.status)) {
        throw conflict('The guest has not checked in', 'not_checked_in');
      }
      const problem = await openItemsProblem(booking._id);
      if (problem) throw conflict(problem, 'open_items');
      await prepareInvoiceCounter();
      const done = await inTransaction((session) =>
        finalizeInSession(session, actor, bill._id, booking),
      );
      return assemble(done);
    },

    async finalizeForCheckout(session, actor, booking) {
      const existing = await Bill.findOne({ bookingId: booking._id }).session(session).lean();
      if (!existing) throw new Error('The bill must exist before check-out');
      const bill =
        existing.status === 'open'
          ? await finalizeInSession(session, actor, existing._id, booking)
          : existing;
      const { balancePaise } = await currentBalance(bill, session);
      return { bill, balancePaise };
    },

    async creditNote(actor, id, input) {
      const bill = await loadBill(id);
      if (bill.status !== 'finalized' || !bill.invoice) {
        throw conflict(
          'Only an issued invoice can be corrected with a credit note',
          'not_finalized',
        );
      }
      const line = bill.lines.find((candidate) => candidate.lineId === input.lineId);
      if (!line) throw new HttpError(404, 'line_not_found', 'That line is not on this bill');
      if (line.kind === 'discount') {
        throw conflict('A discount cannot be reversed with a credit note', 'credit_not_allowed');
      }
      const prop = await property();
      const year = financialYear(todayIn(prop.timezone));
      await ensureCounter(`credit_note:${year}`);
      const invoiceNumber = bill.invoice.number;

      const updated = await inTransaction(async (session) => {
        const fresh = await bump(session, bill._id, 'finalized');
        if (!fresh) throw conflict('This bill changed, please reload', 'conflict');
        const already = await CreditNote.exists({ billId: bill._id, lineId: line.lineId }).session(
          session,
        );
        if (already) throw conflict('That line already has a credit note', 'already_credited');

        const seq = await nextNumber(session, `credit_note:${year}`);
        const number = `CN/${year}/${pad(seq)}`;
        await CreditNote.create(
          [
            {
              billId: bill._id,
              bookingId: bill.bookingId,
              invoiceNumber,
              number,
              lineId: line.lineId,
              description: line.description,
              taxablePaise: line.taxablePaise,
              cgstPaise: line.cgstPaise,
              sgstPaise: line.sgstPaise,
              igstPaise: line.igstPaise,
              taxPaise: line.taxPaise,
              totalPaise: line.totalPaise,
              reason: input.reason,
              issuedBy: actor.name,
              issuedAt: new Date(),
            },
          ],
          { session },
        );
        await audit(
          'credit_note_issued',
          fresh,
          {
            creditNoteNumber: number,
            invoiceNumber,
            lineId: line.lineId,
            totalPaise: line.totalPaise,
            reason: input.reason,
          },
          session,
        );
        return fresh;
      });
      return assemble(updated);
    },

    ...createPaymentLedger(property),
  };
}
