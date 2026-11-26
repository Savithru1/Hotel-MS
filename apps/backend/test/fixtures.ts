import { DEPARTMENTS, type StaffRole } from '@hospitality/constants';
import type { Types } from 'mongoose';
import { Staff } from '../src/modules/staff/staff.model';
import { SEED_PASSWORD, type SeededProperty } from '../src/modules/seed/seed';
import { runWithTenant } from '../src/shared/request-context';
import { hashPassword } from '../src/shared/password';
import { addDays, todayIn } from '../src/shared/dates';
import type { Client, TestApp } from './http';

export const TZ = 'Asia/Kolkata';
export const today = (): string => todayIn(TZ);
export const day = (offset: number): string => addDays(today(), offset);

export interface Lookup {
  types: Record<string, string>;
  rooms: Record<string, string>;
}

/** Room type and room ids by name and number, read through the API as the given client. */
export async function lookup(client: Client): Promise<Lookup> {
  const types: Record<string, string> = {};
  const rooms: Record<string, string> = {};
  for (const type of (await client.get('/api/v1/room-types')).body.data as {
    id: string;
    name: string;
  }[]) {
    types[type.name] = type.id;
  }
  for (const room of (await client.get('/api/v1/rooms?limit=100')).body.data as {
    id: string;
    number: string;
  }[]) {
    rooms[room.number] = room.id;
  }
  return { types, rooms };
}

let counter = 0;

/** Creates an extra, ready-to-use staff member in a property (for "two people at once" tests). */
export async function addStaff(
  t: TestApp,
  property: SeededProperty,
  role: Exclude<StaffRole, 'platform_admin'>,
): Promise<{ id: Types.ObjectId; client: Client }> {
  const passwordHash = await hashPassword(SEED_PASSWORD, 4);
  const number = ++counter;
  const created = await runWithTenant(property.id, () =>
    Staff.create({
      name: `Extra ${role} ${number}`,
      email: `extra${number}.${role}@example.test`,
      role,
      departments: role === 'manager' || role === 'property_admin' ? [...DEPARTMENTS] : [role],
      passwordHash,
      mustChangePassword: false,
    }),
  );
  return { id: created._id, client: await t.actAs(created._id, property.id) };
}

/** Books a room for today and checks the guest in, so the room has a guest in it. */
export async function checkInGuest(
  desk: Client,
  ids: Lookup,
  roomNumber: string,
  typeName: string,
  phone: string,
): Promise<{ bookingId: string }> {
  const booking = await desk.post('/api/v1/bookings', {
    guest: { name: 'In House Guest', phone },
    roomTypeId: ids.types[typeName],
    roomId: ids.rooms[roomNumber],
    checkInDate: today(),
    checkOutDate: day(2),
    adults: 1,
  });
  const checkedIn = await desk.post(`/api/v1/bookings/${booking.body.data.id}/check-in`, {});
  if (checkedIn.status !== 200)
    throw new Error(`check-in failed: ${JSON.stringify(checkedIn.body)}`);
  return { bookingId: booking.body.data.id as string };
}
