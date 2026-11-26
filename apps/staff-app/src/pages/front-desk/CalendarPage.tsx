import type { CalendarBookingDto, RoomDto } from '@hospitality/shared-types';
import { useState } from 'react';
import { Async, Button, Card, PageHeader, TextField } from '../../components/ui';
import { useGet, useList } from '../../hooks/queries';
import { useRefetchOnEvents } from '../../realtime/RealtimeProvider';

const DAYS = 14;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const STATUS_BAR: Record<string, string> = {
  pending: 'bg-amber-200 text-amber-950',
  confirmed: 'bg-sky-200 text-sky-950',
  checked_in: 'bg-violet-300 text-violet-950',
};

export function CalendarPage() {
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 10));
  const end = addDays(start, DAYS - 1);
  const rooms = useList<RoomDto>('/rooms', { limit: 100, active: true });
  const bookings = useGet<CalendarBookingDto[]>('/bookings/calendar', { from: start, to: end });
  useRefetchOnEvents(['booking.changed'], [['/bookings/calendar']]);

  const days = Array.from({ length: DAYS }, (_, index) => addDays(start, index));
  const list = bookings.data?.data ?? [];

  /** The booking holding a room on a night, if any. A stay covers check-in up to, not including, check-out. */
  const holder = (roomId: string, night: string): CalendarBookingDto | undefined =>
    list.find(
      (booking) =>
        booking.roomId === roomId && booking.checkInDate <= night && night < booking.checkOutDate,
    );

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Each coloured block is a night a room is held"
        actions={
          <div className="flex items-end gap-2">
            <Button variant="secondary" onClick={() => setStart(addDays(start, -7))}>
              ◀ Week
            </Button>
            <TextField
              label="From"
              type="date"
              value={start}
              onChange={(e) => e.target.value && setStart(e.target.value)}
            />
            <Button variant="secondary" onClick={() => setStart(addDays(start, 7))}>
              Week ▶
            </Button>
          </div>
        }
      />
      <Card>
        <Async query={bookings}>
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white px-2 py-1 text-left">Room</th>
                  {days.map((day) => (
                    <th key={day} className="px-1 py-1 text-center font-medium text-slate-600">
                      {new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        timeZone: 'UTC',
                      })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rooms.items.map((room) => (
                  <tr key={room.id}>
                    <th
                      scope="row"
                      className="sticky left-0 whitespace-nowrap bg-white px-2 py-1 text-left font-medium"
                    >
                      {room.number}
                      <span className="ml-1 font-normal text-slate-400">{room.roomTypeName}</span>
                    </th>
                    {days.map((day) => {
                      const booking = holder(room.id, day);
                      return (
                        <td key={day} className="h-8 min-w-14 border border-stone-100 p-0">
                          {booking && (
                            <div
                              title={`${booking.guestName} · ${booking.bookingCode}`}
                              className={`h-full truncate px-1 py-1.5 ${STATUS_BAR[booking.status] ?? 'bg-slate-200'}`}
                            >
                              {booking.checkInDate === day || day === start
                                ? booking.guestName
                                : ''}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Async>
      </Card>
    </div>
  );
}
