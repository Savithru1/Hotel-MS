import type { BookingDto } from '@hospitality/shared-types';
import { Room } from '../rooms/room.model';
import { RoomType } from '../rooms/room-type.model';
import type { BookingDocument } from './booking.model';

/** Turns bookings into API objects, looking up room numbers and type names in two queries. */
export async function toBookingDtos(bookings: BookingDocument[]): Promise<BookingDto[]> {
  if (bookings.length === 0) return [];
  const [rooms, types] = await Promise.all([
    Room.find({ _id: { $in: [...new Set(bookings.map((b) => b.roomId))] } }, { number: 1 }).lean(),
    RoomType.find(
      { _id: { $in: [...new Set(bookings.map((b) => b.roomTypeId))] } },
      { name: 1 },
    ).lean(),
  ]);
  const roomNumbers = new Map(rooms.map((room) => [room._id.toHexString(), room.number]));
  const typeNames = new Map(types.map((type) => [type._id.toHexString(), type.name]));

  return bookings.map((booking) => ({
    id: booking._id.toHexString(),
    bookingCode: booking.bookingCode,
    status: booking.status,
    guest: {
      id: booking.guestId.toHexString(),
      name: booking.guestSnapshot.name,
      phone: booking.guestSnapshot.phone,
      email: booking.guestSnapshot.email,
    },
    roomTypeId: booking.roomTypeId.toHexString(),
    roomTypeName: typeNames.get(booking.roomTypeId.toHexString()) ?? null,
    roomId: booking.roomId.toHexString(),
    roomNumber: roomNumbers.get(booking.roomId.toHexString()) ?? null,
    checkInDate: booking.checkInDate,
    checkOutDate: booking.checkOutDate,
    nights: booking.nights,
    adults: booking.adults,
    children: booking.children,
    nightlyRatePaise: booking.nightlyRatePaise,
    roomTotalPaise: booking.nightlyRatePaise * booking.nights,
    notes: booking.notes,
    source: booking.source,
    checkedInAt: booking.checkedInAt ? booking.checkedInAt.toISOString() : null,
    checkedOutAt: booking.checkedOutAt ? booking.checkedOutAt.toISOString() : null,
    cancelledAt: booking.cancelledAt ? booking.cancelledAt.toISOString() : null,
    cancelReason: booking.cancelReason,
    createdAt: booking.createdAt.toISOString(),
  }));
}

export async function toBookingDto(booking: BookingDocument): Promise<BookingDto> {
  const [dto] = await toBookingDtos([booking]);
  if (!dto) throw new Error('Could not build the booking');
  return dto;
}
