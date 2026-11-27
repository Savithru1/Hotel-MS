import { GST_CATEGORIES, type GstCategory } from '@hospitality/constants';
import type {
  CashFlowDayDto,
  RevenueAmountDto,
  RevenueDayDto,
  RevenueDto,
} from '@hospitality/shared-types';
import { BackgroundJob } from '../../jobs/job.model';
import { todayIn } from '../../shared/dates';
import { Bill } from '../billing/bill.model';
import { CreditNote } from '../billing/credit-note.model';
import { Payment } from '../billing/payment.model';
import { eachDate, rangeInstants, type DateRange } from './stats.range';

type Departments = Record<GstCategory, RevenueAmountDto>;

/** Taxable value and tax of one department on one day, before the total is worked out. */
interface Figures {
  taxablePaise: number;
  taxPaise: number;
}

const amount = ({ taxablePaise, taxPaise }: Figures): RevenueAmountDto => ({
  taxablePaise,
  taxPaise,
  totalPaise: taxablePaise + taxPaise,
});

const add = (left: Figures, right: Figures): Figures => ({
  taxablePaise: left.taxablePaise + right.taxablePaise,
  taxPaise: left.taxPaise + right.taxPaise,
});

const NONE: Figures = { taxablePaise: 0, taxPaise: 0 };
const key = (date: string, category: GstCategory): string => `${date}|${category}`;

/**
 * A discount is reported as a negative amount under "other", whatever it was taxed as, so the
 * department figures show what was sold and the discounts show on their own.
 */
const CATEGORY_OF_LINE = {
  $cond: [{ $eq: ['$lines.kind', 'discount'] }, 'other', '$lines.category'],
};

/** Posted bill lines by service date and department. */
async function postedLines(range: DateRange): Promise<Map<string, Figures>> {
  const inRange = { $gte: range.from, $lte: range.to };
  const rows = await Bill.aggregate<{
    _id: { date: string; category: GstCategory };
    taxablePaise: number;
    taxPaise: number;
  }>([
    { $match: { 'lines.serviceDate': inRange } },
    { $unwind: '$lines' },
    { $match: { 'lines.serviceDate': inRange } },
    {
      $group: {
        _id: { date: '$lines.serviceDate', category: CATEGORY_OF_LINE },
        taxablePaise: { $sum: '$lines.taxablePaise' },
        taxPaise: { $sum: '$lines.taxPaise' },
      },
    },
  ]);
  return new Map(rows.map((row) => [key(row._id.date, row._id.category), row]));
}

/** The department each reversed line was posted under, found with two queries (no lookup). */
async function departmentsOfLines(
  notes: readonly { billId: { toHexString(): string }; lineId: string }[],
): Promise<Map<string, GstCategory>> {
  const billIds = [...new Set(notes.map((note) => note.billId.toHexString()))];
  if (billIds.length === 0) return new Map();
  const bills = await Bill.find(
    { _id: { $in: billIds } },
    { 'lines.lineId': 1, 'lines.category': 1, 'lines.kind': 1 },
  ).lean();
  const result = new Map<string, GstCategory>();
  for (const bill of bills) {
    for (const posted of bill.lines) {
      const category = posted.kind === 'discount' ? 'other' : posted.category;
      result.set(`${bill._id.toHexString()}|${posted.lineId}`, category);
    }
  }
  return result;
}

/** Credit notes, as negative amounts on the property-local day they were issued. */
async function creditNotes(range: DateRange, timezone: string): Promise<Map<string, Figures>> {
  const { start, end } = rangeInstants(range, timezone);
  const notes = await CreditNote.find({ issuedAt: { $gte: start, $lt: end } }).lean();
  const departments = await departmentsOfLines(notes);

  const result = new Map<string, Figures>();
  for (const note of notes) {
    const category = departments.get(`${note.billId.toHexString()}|${note.lineId}`) ?? 'other';
    const at = key(todayIn(timezone, note.issuedAt), category);
    const reversed = { taxablePaise: -note.taxablePaise, taxPaise: -note.taxPaise };
    result.set(at, add(result.get(at) ?? NONE, reversed));
  }
  return result;
}

/** Money received and refunded per property-local day (the day is decided by MongoDB). */
async function cashFlow(range: DateRange, timezone: string): Promise<CashFlowDayDto[]> {
  const { start, end } = rangeInstants(range, timezone);
  const rows = await Payment.aggregate<{
    _id: { date: string; kind: 'payment' | 'refund' };
    paise: number;
  }>([
    { $match: { createdAt: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone } },
          kind: '$kind',
        },
        paise: { $sum: '$amountPaise' },
      },
    },
  ]);
  const sumOf = (date: string, kind: 'payment' | 'refund'): number =>
    rows.find((row) => row._id.date === date && row._id.kind === kind)?.paise ?? 0;
  return eachDate(range).map((date) => ({
    date,
    receivedPaise: sumOf(date, 'payment'),
    refundedPaise: sumOf(date, 'refund'),
  }));
}

async function lastSyncedAt(): Promise<string | null> {
  const job = await BackgroundJob.findOne(
    { type: 'billing.sync_open' },
    { lastFinishedAt: 1 },
  ).lean();
  return job?.lastFinishedAt ? job.lastFinishedAt.toISOString() : null;
}

function buildDay(
  date: string,
  lines: Map<string, Figures>,
  notes: Map<string, Figures>,
): RevenueDayDto {
  const figures = Object.fromEntries(
    GST_CATEGORIES.map((category) => [
      category,
      add(lines.get(key(date, category)) ?? NONE, notes.get(key(date, category)) ?? NONE),
    ]),
  ) as Record<GstCategory, Figures>;
  const departments = Object.fromEntries(
    GST_CATEGORIES.map((category) => [category, amount(figures[category])]),
  ) as Departments;
  const total = amount(GST_CATEGORIES.reduce((sum, category) => add(sum, figures[category]), NONE));
  return { date, departments, total };
}

function sumDays(days: readonly RevenueDayDto[]): RevenueDto['totals'] {
  const departments = Object.fromEntries(
    GST_CATEGORIES.map((category) => [
      category,
      amount(days.reduce((sum, day) => add(sum, day.departments[category]), NONE)),
    ]),
  ) as Departments;
  const total = amount(days.reduce((sum, day) => add(sum, day.total), NONE));
  return { departments, total };
}

/**
 * Revenue for a date range: posted bill lines by service date and department (taxable value
 * and GST apart), credit notes taken off on the day they were issued, and the money that
 * actually came in or went out, kept separate as cash flow.
 */
export async function revenueFor(range: DateRange, timezone: string): Promise<RevenueDto> {
  const [lines, notes, payments, syncedAt] = await Promise.all([
    postedLines(range),
    creditNotes(range, timezone),
    cashFlow(range, timezone),
    lastSyncedAt(),
  ]);
  const days = eachDate(range).map((date) => buildDay(date, lines, notes));
  return { ...range, days, totals: sumDays(days), payments, lastSyncedAt: syncedAt };
}
