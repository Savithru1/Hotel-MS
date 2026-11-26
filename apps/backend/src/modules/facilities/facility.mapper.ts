import type { FacilityBookingDto, FacilityDto } from '@hospitality/shared-types';
import type { FacilityBookingDocument } from './facility-booking.model';
import type { FacilityDocument } from './facility.model';

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toFacilityDto(facility: FacilityDocument): FacilityDto {
  return {
    id: facility._id.toHexString(),
    name: facility.name,
    type: facility.type,
    description: facility.description,
    capacity: facility.capacity,
    slotMinutes: facility.slotMinutes,
    opensAt: facility.opensAt,
    closesAt: facility.closesAt,
    pricePaise: facility.pricePaise,
    active: facility.active,
    createdAt: facility.createdAt.toISOString(),
    updatedAt: facility.updatedAt.toISOString(),
  };
}

export function toFacilityBookingDto(booking: FacilityBookingDocument): FacilityBookingDto {
  return {
    id: booking._id.toHexString(),
    code: booking.code,
    facilityId: booking.facilityId.toHexString(),
    facilityName: booking.facilityName,
    facilityType: booking.facilityType,
    roomId: booking.roomId.toHexString(),
    roomNumber: booking.roomNumber,
    bookingId: booking.bookingId.toHexString(),
    guestName: booking.guestName,
    date: booking.date,
    startTime: booking.startTime,
    endTime: booking.endTime,
    participants: booking.participants,
    unitPricePaise: booking.unitPricePaise,
    totalPaise: booking.totalPaise,
    notes: booking.notes,
    status: booking.status,
    cancelReason: booking.cancelReason,
    source: booking.source,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    confirmedAt: iso(booking.confirmedAt),
    startedAt: iso(booking.startedAt),
    completedAt: iso(booking.completedAt),
    cancelledAt: iso(booking.cancelledAt),
  };
}
