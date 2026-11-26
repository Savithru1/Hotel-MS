import type {
  FacilityBookingDto,
  FacilityBookingSummaryDto,
  FacilityDto,
} from '@hospitality/shared-types';
import { useState } from 'react';
import { useStaff } from '../../auth/AuthContext';
import { isManager } from '../../auth/permissions';
import {
  Async,
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SelectField,
  TextField,
  errorText,
  money,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useGet, useList, useSend } from '../../hooks/queries';
import { useRefetchOnEvents } from '../../realtime/RealtimeProvider';
import { CancelFacilityBookingDialog } from './CancelFacilityBookingDialog';
import { NewFacilityBookingDialog } from './NewFacilityBookingDialog';

/** Today's date in the browser's timezone, as `YYYY-MM-DD`. */
const todayLocal = (): string => new Date().toLocaleDateString('en-CA');

const COLUMNS = [
  { title: 'Requested', statuses: ['requested'], empty: 'No requests waiting.' },
  { title: 'Confirmed', statuses: ['confirmed'], empty: 'Nothing confirmed.' },
  { title: 'In progress', statuses: ['active'], empty: 'Nothing in progress.' },
  { title: 'Completed', statuses: ['completed'], empty: 'Nothing completed yet.' },
  {
    title: 'Cancelled and no-shows',
    statuses: ['cancelled', 'no_show'],
    empty: 'No cancellations.',
  },
] as const;

const OPEN_STATUSES = ['requested', 'confirmed', 'active'] as const;

function BookingCard({
  booking,
  canRun,
  onCancel,
}: {
  booking: FacilityBookingDto;
  canRun: boolean;
  onCancel: (booking: FacilityBookingDto) => void;
}) {
  const toast = useToast();
  const base = `/facility-bookings/${booking.id}`;
  const refresh = ['/facility-bookings'];
  const confirm = useSend<FacilityBookingDto, void>('post', `${base}/confirm`, refresh);
  const start = useSend<FacilityBookingDto, void>('post', `${base}/start`, refresh);
  const complete = useSend<FacilityBookingDto, void>('post', `${base}/complete`, refresh);
  const noShow = useSend<FacilityBookingDto, void>('post', `${base}/no-show`, refresh);
  const fail = (error: unknown): void => toast.error(errorText(error));

  return (
    <li className="rounded-lg bg-white p-3 ring-1 ring-inset ring-stone-200">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            <span>
              {booking.startTime}–{booking.endTime}
            </span>
          </p>
          <p className="text-sm text-slate-800">{booking.facilityName}</p>
        </div>
        <span className="font-mono text-xs text-slate-500">{booking.code}</span>
      </div>
      <p className="mt-2 text-sm text-slate-800">Room {booking.roomNumber}</p>
      <p className="text-xs text-slate-600">{booking.guestName}</p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span>
          {booking.participants} {booking.participants === 1 ? 'person' : 'people'}
        </span>
        <span>{money(booking.totalPaise)}</span>
        {booking.status === 'cancelled' && <Badge>Cancelled</Badge>}
        {booking.status === 'no_show' && <Badge tone="bad">No-show</Badge>}
      </p>
      {booking.notes && <p className="mt-1 text-xs text-slate-600">Note: {booking.notes}</p>}
      {booking.cancelReason && (
        <p className="mt-1 text-xs text-slate-600">Reason: {booking.cancelReason}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {booking.status === 'requested' && canRun && (
          <Button
            small
            disabled={confirm.isPending}
            onClick={() => confirm.mutate(undefined, { onError: fail })}
          >
            Confirm
          </Button>
        )}
        {booking.status === 'confirmed' && canRun && (
          <>
            <Button
              small
              disabled={start.isPending}
              onClick={() => start.mutate(undefined, { onError: fail })}
            >
              Start session
            </Button>
            <Button
              variant="secondary"
              small
              disabled={noShow.isPending}
              onClick={() => noShow.mutate(undefined, { onError: fail })}
            >
              Mark no-show
            </Button>
          </>
        )}
        {booking.status === 'active' && canRun && (
          <Button
            small
            disabled={complete.isPending}
            onClick={() => complete.mutate(undefined, { onError: fail })}
          >
            Finish session
          </Button>
        )}
        {(booking.status === 'requested' || booking.status === 'confirmed') && (
          <Button variant="quiet" small onClick={() => onCancel(booking)}>
            Cancel booking
          </Button>
        )}
      </div>
    </li>
  );
}

function Column({
  title,
  bookings,
  empty,
  canRun,
  onCancel,
}: {
  title: string;
  bookings: FacilityBookingDto[];
  empty: string;
  canRun: boolean;
  onCancel: (booking: FacilityBookingDto) => void;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
        {title} <Badge>{bookings.length}</Badge>
      </h2>
      {bookings.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="space-y-2">
          {bookings.map((booking) => (
            <BookingCard key={booking.id} booking={booking} canRun={canRun} onCancel={onCancel} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The spa and recreation dashboard: a day's bookings by status, updated live. */
export function SpaPage() {
  const { staff } = useStaff();
  const [day, setDay] = useState(todayLocal);
  const [facilityId, setFacilityId] = useState('');
  const [placing, setPlacing] = useState(false);
  const [cancelling, setCancelling] = useState<FacilityBookingDto | null>(null);

  const bookings = useList<FacilityBookingDto>('/facility-bookings', {
    date: day,
    limit: 100,
    ...(facilityId ? { facilityId } : {}),
  });
  const summary = useGet<FacilityBookingSummaryDto>('/facility-bookings/summary', { date: day });
  const facilities = useList<FacilityDto>('/facilities', { limit: 100 });

  const canRun = staff.role === 'spa_recreation' || isManager(staff.role);
  useRefetchOnEvents(
    ['facility_booking.changed'],
    [['/facility-bookings'], ['/facility-bookings/summary']],
  );

  const openCount = OPEN_STATUSES.reduce(
    (sum, status) => sum + (summary.data?.data.byStatus[status] ?? 0),
    0,
  );

  return (
    <div>
      <PageHeader
        title="Spa & recreation"
        subtitle="Bookings for the spa, pool, gym and activities, updated live"
        actions={
          <>
            <TextField
              label="Day"
              type="date"
              value={day}
              onChange={(event) => event.target.value && setDay(event.target.value)}
            />
            <SelectField
              label="Facility"
              value={facilityId}
              onChange={(event) => setFacilityId(event.target.value)}
            >
              <option value="">All facilities</option>
              {facilities.items.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.name}
                </option>
              ))}
            </SelectField>
            <div className="flex items-end">
              <Button onClick={() => setPlacing(true)}>New booking</Button>
            </div>
          </>
        }
      />
      {summary.isError ? (
        <div className="mb-4">
          <ErrorNotice error={summary.error} onRetry={() => void summary.refetch()} />
        </div>
      ) : (
        summary.data && (
          <p className="mb-4 text-sm text-slate-600">
            {openCount} open · {summary.data.data.participantsExpected} people expected
          </p>
        )
      )}

      <Async query={bookings}>
        <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-5">
          {COLUMNS.map((column) => (
            <Column
              key={column.title}
              title={column.title}
              bookings={bookings.items.filter((booking) =>
                (column.statuses as readonly string[]).includes(booking.status),
              )}
              empty={column.empty}
              canRun={canRun}
              onCancel={setCancelling}
            />
          ))}
        </div>
      </Async>

      {placing && <NewFacilityBookingDialog day={day} onClose={() => setPlacing(false)} />}
      {cancelling && (
        <CancelFacilityBookingDialog booking={cancelling} onClose={() => setCancelling(null)} />
      )}
    </div>
  );
}
