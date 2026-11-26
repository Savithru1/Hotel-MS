import { ROOM_STATUSES, type RoomStatus } from '@hospitality/constants';
import type {
  AvailabilityDto,
  BookingDto,
  CalendarBookingDto,
  FrontDeskOverviewDto,
} from '@hospitality/shared-types';
import type { Types } from 'mongoose';
import { nightsOf, todayIn } from '../../shared/dates';
import { notFound } from '../../shared/errors';
import { Room } from '../rooms/room.model';
import { RoomType } from '../rooms/room-type.model';
import { Booking } from './booking.model';
import { toBookingDto, toBookingDtos } from './booking.mapper';
import { RoomNight } from './room-night.model';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rooms that cannot take a guest tonight even though no booking holds them. */
const NOT_READY: RoomStatus[] = ['out_of_service', 'maintenance'];

export interface AvailabilityInput {
  checkInDate: string;
  checkOutDate: string;
  roomTypeId?: string | undefined;
}

export interface ListBookingsInput {
  page: number;
  limit: number;
  status?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  roomId?: string | undefined;
  q?: string | undefined;
}

/** Ids of the given rooms that have at least one of the given nights taken. */
export async function busyRoomIds(
  roomIds: Types.ObjectId[],
  nights: string[],
  ignoreBookingId?: Types.ObjectId,
): Promise<Set<string>> {
  if (roomIds.length === 0 || nights.length === 0) return new Set();
  const taken = await RoomNight.find(
    {
      roomId: { $in: roomIds },
      night: { $in: nights },
      ...(ignoreBookingId ? { bookingId: { $ne: ignoreBookingId } } : {}),
    },
    { roomId: 1 },
  ).lean();
  return new Set(taken.map((night) => night.roomId.toHexString()));
}

export async function findAvailability(
  input: AvailabilityInput,
  today: string,
): Promise<AvailabilityDto> {
  const nights = nightsOf(input.checkInDate, input.checkOutDate);
  const types = await RoomType.find({
    active: true,
    ...(input.roomTypeId ? { _id: input.roomTypeId } : {}),
  })
    .sort({ name: 1 })
    .collation({ locale: 'en', strength: 2 })
    .lean();
  const rooms = await Room.find({ active: true, roomTypeId: { $in: types.map((t) => t._id) } })
    .sort({ number: 1 })
    .collation({ locale: 'en', numericOrdering: true })
    .lean();

  const busy = await busyRoomIds(
    rooms.map((room) => room._id),
    nights,
  );
  const startsNow = input.checkInDate <= today;

  return {
    checkInDate: input.checkInDate,
    checkOutDate: input.checkOutDate,
    nights: nights.length,
    roomTypes: types.map((type) => {
      const ofType = rooms.filter((room) => room.roomTypeId.equals(type._id));
      return {
        roomTypeId: type._id.toHexString(),
        roomTypeName: type.name,
        capacity: type.capacity,
        nightlyRatePaise: type.ratePaise,
        totalRooms: ofType.length,
        availableRooms: ofType
          .filter((room) => !busy.has(room._id.toHexString()))
          .filter((room) => !(startsNow && NOT_READY.includes(room.status)))
          .map((room) => ({ id: room._id.toHexString(), number: room.number, floor: room.floor })),
      };
    }),
  };
}

export async function getBooking(id: string): Promise<BookingDto> {
  const booking = await Booking.findOne({ _id: id }).lean();
  if (!booking) throw notFound('Booking not found');
  return toBookingDto(booking);
}

export async function listBookings(
  input: ListBookingsInput,
): Promise<{ items: BookingDto[]; total: number }> {
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  if (input.roomId) filter.roomId = input.roomId;
  // A stay overlaps the window when it starts on or before the end and leaves after the start.
  if (input.to) filter.checkInDate = { $lte: input.to };
  if (input.from) filter.checkOutDate = { $gt: input.from };
  if (input.q) {
    const text = new RegExp(escapeRegExp(input.q), 'i');
    const digits = new RegExp(escapeRegExp(input.q.replace(/[\s()-]/g, '') || input.q), 'i');
    filter.$or = [
      { bookingCode: text },
      { 'guestSnapshot.name': text },
      { 'guestSnapshot.phone': digits },
    ];
  }

  const [items, total] = await Promise.all([
    Booking.find(filter)
      .sort({ checkInDate: 1, bookingCode: 1 })
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean(),
    Booking.countDocuments(filter),
  ]);
  return { items: await toBookingDtos(items), total };
}

export async function frontDeskOverview(
  timezone: string,
  now = new Date(),
): Promise<FrontDeskOverviewDto> {
  const date = todayIn(timezone, now);
  const [arrivals, departures, inHouse, byStatus, totalRooms] = await Promise.all([
    Booking.find({ checkInDate: date, status: { $in: ['pending', 'confirmed', 'checked_in'] } })
      .sort({ bookingCode: 1 })
      .lean(),
    Booking.find({ checkOutDate: date, status: { $in: ['checked_in', 'checked_out'] } })
      .sort({ bookingCode: 1 })
      .lean(),
    Booking.find({ status: 'checked_in' }).sort({ checkOutDate: 1, bookingCode: 1 }).lean(),
    Room.aggregate<{ _id: RoomStatus; count: number }>([
      { $match: { active: true } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Room.countDocuments({ active: true }),
  ]);

  const roomsByStatus = Object.fromEntries(ROOM_STATUSES.map((status) => [status, 0])) as Record<
    RoomStatus,
    number
  >;
  for (const row of byStatus) roomsByStatus[row._id] = row.count;

  const [arrivalDtos, departureDtos, inHouseDtos] = await Promise.all([
    toBookingDtos(arrivals),
    toBookingDtos(departures),
    toBookingDtos(inHouse),
  ]);
  return {
    date,
    arrivals: arrivalDtos,
    departures: departureDtos,
    inHouse: inHouseDtos,
    counts: {
      arrivalsExpected: arrivals.length,
      arrivalsCheckedIn: arrivals.filter((b) => b.status === 'checked_in').length,
      departuresExpected: departures.filter((b) => b.status === 'checked_in').length,
      inHouse: inHouse.length,
      roomsByStatus,
      totalRooms,
    },
  };
}

export async function calendar(from: string, to: string): Promise<CalendarBookingDto[]> {
  const bookings = await Booking.find({
    status: { $in: ['pending', 'confirmed', 'checked_in'] },
    checkInDate: { $lte: to },
    checkOutDate: { $gt: from },
  })
    .sort({ checkInDate: 1 })
    .limit(2000)
    .lean();
  return bookings.map((booking) => ({
    id: booking._id.toHexString(),
    bookingCode: booking.bookingCode,
    status: booking.status,
    guestName: booking.guestSnapshot.name,
    roomId: booking.roomId.toHexString(),
    checkInDate: booking.checkInDate,
    checkOutDate: booking.checkOutDate,
  }));
}
