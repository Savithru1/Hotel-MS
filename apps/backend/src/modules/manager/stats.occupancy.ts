import { ROOM_STATUSES, type BookingStatus, type RoomStatus } from '@hospitality/constants';
import type { OccupancyDayDto } from '@hospitality/shared-types';
import { Booking } from '../bookings/booking.model';
import { RoomNight } from '../bookings/room-night.model';
import { Room } from '../rooms/room.model';
import { basisPoints, eachDate, type DateRange } from './stats.range';

/** Stays that really happened: used for today and earlier days. */
const ACTUAL_STATUSES: readonly BookingStatus[] = ['checked_in', 'checked_out'];
/**
 * Bookings that hold a night that has not happened yet. A guest who is checked in and stays on
 * also holds tomorrow's night, so `checked_in` counts here as well.
 */
const ON_THE_BOOKS_STATUSES: readonly BookingStatus[] = ['pending', 'confirmed', 'checked_in'];

/** Per-date count of occupied rooms, from the room nights and the status of their bookings. */
async function occupiedByDate(range: DateRange, today: string): Promise<Map<string, number>> {
  const nights = await RoomNight.find(
    { night: { $gte: range.from, $lte: range.to } },
    { night: 1, bookingId: 1 },
  ).lean();
  const bookingIds = [...new Set(nights.map((night) => night.bookingId.toHexString()))];
  const bookings =
    bookingIds.length === 0
      ? []
      : await Booking.find({ _id: { $in: bookingIds } }, { status: 1 }).lean();
  const statusOf = new Map(bookings.map((booking) => [booking._id.toHexString(), booking.status]));

  const counts = new Map<string, number>();
  for (const night of nights) {
    const status = statusOf.get(night.bookingId.toHexString());
    if (!status) continue;
    const counted = night.night <= today ? ACTUAL_STATUSES : ON_THE_BOOKS_STATUSES;
    if (!counted.includes(status)) continue;
    counts.set(night.night, (counts.get(night.night) ?? 0) + 1);
  }
  return counts;
}

/**
 * Occupancy for each date of the range. Today's count of active rooms is the denominator for
 * every date, because the history of room availability is not kept.
 */
export async function occupancyDays(range: DateRange, today: string): Promise<OccupancyDayDto[]> {
  const [occupied, sellable] = await Promise.all([
    occupiedByDate(range, today),
    Room.countDocuments({ active: true }),
  ]);
  return eachDate(range).map((date) => {
    const count = occupied.get(date) ?? 0;
    return {
      date,
      occupied: count,
      sellable,
      rateBp: basisPoints(count, sellable),
      basis: date <= today ? 'actual' : 'on_the_books',
    };
  });
}

/** Active rooms, in total and by their current status. */
export async function roomCounts(): Promise<{ active: number; byStatus: Record<string, number> }> {
  const rows = await Room.aggregate<{ _id: RoomStatus; count: number }>([
    { $match: { active: true } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const byStatus: Record<string, number> = Object.fromEntries(
    ROOM_STATUSES.map((status) => [status, 0]),
  );
  for (const row of rows) byStatus[row._id] = row.count;
  return { active: rows.reduce((sum, row) => sum + row.count, 0), byStatus };
}

interface Movement {
  expected: number;
  done: number;
}

async function countsByStatus(
  field: 'checkInDate' | 'checkOutDate',
  date: string,
): Promise<Map<string, number>> {
  const rows = await Booking.aggregate<{ _id: string; count: number }>([
    { $match: { [field]: date } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
}

const sum = (counts: Map<string, number>, statuses: readonly string[]): number =>
  statuses.reduce((total, status) => total + (counts.get(status) ?? 0), 0);

/** Arrivals and departures due on a date, how many are done, and who is in the house right now. */
export async function movements(
  date: string,
): Promise<{ arrivals: Movement; departures: Movement; inHouse: number }> {
  const [arriving, leaving, inHouse] = await Promise.all([
    countsByStatus('checkInDate', date),
    countsByStatus('checkOutDate', date),
    Booking.countDocuments({ status: 'checked_in' }),
  ]);
  return {
    arrivals: {
      expected: sum(arriving, ['pending', 'confirmed', 'checked_in', 'checked_out']),
      done: sum(arriving, ['checked_in', 'checked_out']),
    },
    departures: {
      expected: sum(leaving, ['checked_in', 'checked_out']),
      done: sum(leaving, ['checked_out']),
    },
    inHouse,
  };
}
