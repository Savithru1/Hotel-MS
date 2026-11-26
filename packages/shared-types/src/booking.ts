import type { BookingStatus, RoomStatus } from '@hospitality/constants';

export interface BookingGuestDto {
  id: string;
  name: string;
  phone: string;
  email: string | null;
}

export interface BookingDto {
  id: string;
  /** The readable code the guest quotes, for example `BK-7H3K9Q`. Also their login Booking ID later. */
  bookingCode: string;
  status: BookingStatus;
  guest: BookingGuestDto;
  roomTypeId: string;
  roomTypeName: string | null;
  roomId: string;
  roomNumber: string | null;
  /** `YYYY-MM-DD` in the property's timezone. The guest sleeps from this date. */
  checkInDate: string;
  /** `YYYY-MM-DD`. The guest leaves on the morning of this date, so it is not a night of the stay. */
  checkOutDate: string;
  nights: number;
  adults: number;
  children: number;
  /** The room type's nightly tariff when the booking was made. Later tariff changes do not touch it. */
  nightlyRatePaise: number;
  /** Room charge estimate (nights x tariff). The bill itself is built in billing. */
  roomTotalPaise: number;
  notes: string;
  source: 'front_desk';
  checkedInAt: string | null;
  checkedOutAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

export interface AvailableRoomDto {
  id: string;
  number: string;
  floor: number;
}

export interface RoomTypeAvailabilityDto {
  roomTypeId: string;
  roomTypeName: string;
  capacity: number;
  nightlyRatePaise: number;
  totalRooms: number;
  availableRooms: AvailableRoomDto[];
}

export interface AvailabilityDto {
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  roomTypes: RoomTypeAvailabilityDto[];
}

export interface FrontDeskOverviewDto {
  /** Today in the property's timezone. */
  date: string;
  arrivals: BookingDto[];
  departures: BookingDto[];
  inHouse: BookingDto[];
  counts: {
    arrivalsExpected: number;
    arrivalsCheckedIn: number;
    departuresExpected: number;
    inHouse: number;
    roomsByStatus: Record<RoomStatus, number>;
    totalRooms: number;
  };
}

export interface CalendarBookingDto {
  id: string;
  bookingCode: string;
  status: BookingStatus;
  guestName: string;
  roomId: string;
  checkInDate: string;
  checkOutDate: string;
}
