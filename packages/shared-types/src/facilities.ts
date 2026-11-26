import type { FacilityBookingStatus, FacilityType } from '@hospitality/constants';

export interface FacilityDto {
  id: string;
  name: string;
  type: FacilityType;
  description: string;
  /** How many people one slot takes. */
  capacity: number;
  slotMinutes: number;
  /** `HH:mm` in the property's timezone. */
  opensAt: string;
  closesAt: string;
  /** Per person, per slot, in paise, before tax. */
  pricePaise: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One slot of one day, with how full it is. */
export interface FacilitySlotDto {
  startTime: string;
  endTime: string;
  capacity: number;
  booked: number;
  remaining: number;
  /** The slot has already started, so it can no longer be booked. */
  past: boolean;
  /** Not past and not full. */
  bookable: boolean;
}

export interface FacilityBookingDto {
  id: string;
  /** Short readable code such as `FB-7H3K9Q`. */
  code: string;
  facilityId: string;
  facilityName: string;
  facilityType: FacilityType;
  roomId: string;
  roomNumber: string;
  bookingId: string;
  guestName: string;
  /** `YYYY-MM-DD` in the property's timezone. */
  date: string;
  startTime: string;
  endTime: string;
  participants: number;
  /** Price per person copied when the booking was made. */
  unitPricePaise: number;
  totalPaise: number;
  notes: string;
  status: FacilityBookingStatus;
  cancelReason: string | null;
  source: 'front_desk' | 'spa_recreation' | 'guest';
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface FacilityBookingSummaryDto {
  date: string;
  byStatus: Record<string, number>;
  /** People booked into open slots that day. */
  participantsExpected: number;
}
