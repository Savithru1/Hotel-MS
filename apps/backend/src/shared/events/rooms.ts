import type { Department } from '@hospitality/constants';
import type { Audience, DomainEvent } from './event-bus';

const SAFE_ID = /^[0-9a-f]{24}$/i;

function safeId(value: string, what: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`Refusing to build a realtime room from a bad ${what}`);
  return value.toLowerCase();
}

/**
 * Room names. Every room starts with the property id, so a connection that belongs to one
 * property can never be in a room of another. Only the server decides who joins which room.
 */
export const rooms = {
  department: (propertyId: string, department: Department): string =>
    `p:${safeId(propertyId, 'property id')}:dept:${department}`,
  managers: (propertyId: string): string => `p:${safeId(propertyId, 'property id')}:managers`,
  staff: (propertyId: string, staffId: string): string =>
    `p:${safeId(propertyId, 'property id')}:user:${safeId(staffId, 'staff id')}`,
  booking: (propertyId: string, bookingId: string): string =>
    `p:${safeId(propertyId, 'property id')}:booking:${safeId(bookingId, 'booking id')}`,
};

/** The rooms that should receive an event. */
export function roomsFor(event: DomainEvent): string[] {
  const propertyId = String(event.propertyId);
  const audience: Audience = event.audience;
  const result = new Set<string>();

  for (const department of audience.departments ?? []) {
    result.add(rooms.department(propertyId, department));
  }
  if (audience.managers !== false) result.add(rooms.managers(propertyId));
  for (const id of audience.staffIds ?? []) result.add(rooms.staff(propertyId, id));
  for (const id of audience.bookingIds ?? []) result.add(rooms.booking(propertyId, id));

  return [...result];
}
