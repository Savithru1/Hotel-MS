import type { BookingDto, FrontDeskOverviewDto, RoomDto } from '@hospitality/shared-types';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  Async,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  PageHeader,
  StatusBadge,
  dateLabel,
  words,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useGet, useList, useSend } from '../../hooks/queries';
import { useRefetchOnEvents } from '../../realtime/RealtimeProvider';
import { HousekeepingRequestDialog, MaintenanceIssueDialog } from '../operations/RequestDialogs';
import { errorText } from '../../components/ui';

const ROOM_TONE: Record<string, string> = {
  available: 'bg-emerald-50 text-emerald-900 ring-emerald-300 hover:bg-emerald-100',
  occupied: 'bg-violet-50 text-violet-900 ring-violet-300 hover:bg-violet-100',
  reserved: 'bg-sky-50 text-sky-900 ring-sky-300 hover:bg-sky-100',
  cleaning: 'bg-amber-50 text-amber-900 ring-amber-300 hover:bg-amber-100',
  maintenance: 'bg-rose-50 text-rose-900 ring-rose-300 hover:bg-rose-100',
  out_of_service: 'bg-slate-100 text-slate-700 ring-slate-300 hover:bg-slate-200',
};

function RoomBoard({ rooms, onPick }: { rooms: RoomDto[]; onPick: (room: RoomDto) => void }) {
  const floors = [...new Set(rooms.map((room) => room.floor))].sort((a, b) => a - b);
  if (rooms.length === 0) return <EmptyState>No rooms yet. Add them under Rooms.</EmptyState>;
  return (
    <div className="space-y-4">
      {floors.map((floor) => (
        <div key={floor}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Floor {floor}
          </h3>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {rooms
              .filter((room) => room.floor === floor)
              .map((room) => (
                <li key={room.id}>
                  <button
                    type="button"
                    onClick={() => onPick(room)}
                    aria-label={`Room ${room.number}, ${words(room.status)}`}
                    className={`w-full rounded-lg px-2 py-2 text-left text-sm ring-1 ring-inset transition-colors ${
                      ROOM_TONE[room.status] ?? ''
                    } ${room.active ? '' : 'opacity-50'}`}
                  >
                    <span className="block font-semibold">{room.number}</span>
                    <span className="block text-xs capitalize">{words(room.status)}</span>
                    <span className="block truncate text-xs opacity-70">{room.roomTypeName}</span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function RoomDialog({
  room,
  rooms,
  onClose,
}: {
  room: RoomDto;
  rooms: RoomDto[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [panel, setPanel] = useState<'none' | 'housekeeping' | 'issue'>('none');
  const setStatus = useSend<RoomDto, { status: string }>('post', `/rooms/${room.id}/status`, [
    '/rooms',
    '/bookings/overview',
  ]);

  if (panel === 'housekeeping') {
    return <HousekeepingRequestDialog rooms={rooms} roomId={room.id} onClose={onClose} />;
  }
  if (panel === 'issue') {
    return <MaintenanceIssueDialog rooms={rooms} roomId={room.id} onClose={onClose} />;
  }

  const options = [
    { status: 'cleaning', label: 'Mark as needing cleaning' },
    { status: 'available', label: 'Mark as available' },
    { status: 'out_of_service', label: 'Take out of service' },
  ].filter((option) => option.status !== room.status);

  return (
    <Dialog title={`Room ${room.number}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <StatusBadge status={room.status} /> {room.roomTypeName} · floor {room.floor}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setPanel('housekeeping')}>
            Log housekeeping request
          </Button>
          <Button variant="secondary" onClick={() => setPanel('issue')}>
            Report maintenance issue
          </Button>
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
            Change status
          </p>
          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option.status}
                variant="quiet"
                small
                disabled={setStatus.isPending}
                onClick={() =>
                  setStatus.mutate(
                    { status: option.status },
                    {
                      onSuccess: () => {
                        toast.success(`Room ${room.number} updated`);
                        onClose();
                      },
                      onError: (error) => toast.error(errorText(error)),
                    },
                  )
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            A room with a guest in it, or due in, cannot be changed by hand. Check-in and check-out
            do that.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

function BookingRow({ booking, action }: { booking: BookingDto; action?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-900">
          {booking.guest.name}{' '}
          <span className="font-normal text-slate-500">· Room {booking.roomNumber}</span>
        </p>
        <p className="text-xs text-slate-500">
          {booking.bookingCode} · {dateLabel(booking.checkInDate)} →{' '}
          {dateLabel(booking.checkOutDate)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={booking.status} />
        {action}
      </div>
    </li>
  );
}

export function FrontDeskPage() {
  const toast = useToast();
  const overview = useGet<FrontDeskOverviewDto>('/bookings/overview');
  const rooms = useList<RoomDto>('/rooms', { limit: 100 });
  const [picked, setPicked] = useState<RoomDto | null>(null);
  const checkIn = useSend<BookingDto, { id: string }>(
    'post',
    (body) => `/bookings/${body.id}/check-in`,
    ['/bookings', '/rooms'],
  );

  useRefetchOnEvents(
    ['booking.changed', 'room.status_changed'],
    [['/bookings/overview'], ['/rooms']],
  );

  const data = overview.data?.data;
  const today = data
    ? new Date(`${data.date}T00:00:00Z`).toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC',
      })
    : '';
  const occupied = data?.counts.roomsByStatus.occupied ?? 0;

  return (
    <div>
      <PageHeader
        title="Today at the front desk"
        subtitle={today}
        actions={
          <Link
            to="/bookings/new"
            className="rounded-md bg-teal-800 px-4 py-2 text-sm font-medium text-white hover:bg-teal-900"
          >
            New booking
          </Link>
        }
      />

      <Async query={overview}>
        {data && (
          <>
            <dl className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                [
                  'Arriving today',
                  `${data.counts.arrivalsCheckedIn} of ${data.counts.arrivalsExpected} in`,
                ],
                ['Leaving today', String(data.counts.departuresExpected)],
                ['In house', String(data.counts.inHouse)],
                ['Occupancy', `${occupied} of ${data.counts.totalRooms} rooms`],
              ].map(([term, value]) => (
                <div key={term} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
                  <dt className="text-xs uppercase tracking-wider text-slate-500">{term}</dt>
                  <dd className="mt-1 font-serif text-2xl text-slate-900">{value}</dd>
                </div>
              ))}
            </dl>

            <div className="grid gap-6 xl:grid-cols-3">
              <Card title="Arrivals">
                {data.arrivals.length === 0 ? (
                  <EmptyState>No arrivals today.</EmptyState>
                ) : (
                  <ul className="divide-y divide-stone-100">
                    {data.arrivals.map((booking) => (
                      <BookingRow
                        key={booking.id}
                        booking={booking}
                        action={
                          booking.status === 'confirmed' ? (
                            <Button
                              small
                              disabled={checkIn.isPending}
                              onClick={() =>
                                checkIn.mutate(
                                  { id: booking.id },
                                  {
                                    onSuccess: () =>
                                      toast.success(`${booking.guest.name} checked in`),
                                    onError: (error) => toast.error(errorText(error)),
                                  },
                                )
                              }
                            >
                              Check in
                            </Button>
                          ) : booking.status === 'pending' ? (
                            <Badge tone="warn">Needs confirming</Badge>
                          ) : undefined
                        }
                      />
                    ))}
                  </ul>
                )}
              </Card>

              <Card title="Departures">
                {data.departures.length === 0 ? (
                  <EmptyState>No departures today.</EmptyState>
                ) : (
                  <ul className="divide-y divide-stone-100">
                    {data.departures.map((booking) => (
                      <BookingRow key={booking.id} booking={booking} />
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-xs text-slate-500">
                  Check-out and the final bill arrive with billing.
                </p>
              </Card>

              <Card title="In house">
                {data.inHouse.length === 0 ? (
                  <EmptyState>Nobody is checked in.</EmptyState>
                ) : (
                  <ul className="divide-y divide-stone-100">
                    {data.inHouse.map((booking) => (
                      <BookingRow key={booking.id} booking={booking} />
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        )}
      </Async>

      <Card title="Room board" className="mt-6">
        <Async query={rooms}>
          <RoomBoard rooms={rooms.items} onPick={setPicked} />
        </Async>
      </Card>

      {picked && <RoomDialog room={picked} rooms={rooms.items} onClose={() => setPicked(null)} />}
    </div>
  );
}
