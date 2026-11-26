import type { BookingDto } from '@hospitality/shared-types';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  Async,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SelectField,
  StatusBadge,
  TextAreaField,
  TextField,
  dateLabel,
  errorText,
  money,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useList, useSend } from '../../hooks/queries';
import { useRefetchOnEvents } from '../../realtime/RealtimeProvider';

function CancelForm({
  booking,
  onDone,
  onBack,
}: {
  booking: BookingDto;
  onDone: () => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const cancel = useSend<BookingDto, { reason: string }>('post', `/bookings/${booking.id}/cancel`, [
    '/bookings',
  ]);
  return (
    <form
      className="space-y-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        cancel.mutate(
          { reason },
          {
            onSuccess: () => {
              toast.success('Booking cancelled');
              onDone();
            },
          },
        );
      }}
    >
      <TextField
        label="Reason for cancelling"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={200}
        required
      />
      {cancel.isError && <ErrorNotice error={cancel.error} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button
          variant="danger"
          type="submit"
          disabled={cancel.isPending || reason.trim().length < 3}
        >
          Cancel booking
        </Button>
      </div>
    </form>
  );
}

function EditForm({
  booking,
  onDone,
  onBack,
}: {
  booking: BookingDto;
  onDone: () => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const [checkInDate, setCheckInDate] = useState(booking.checkInDate);
  const [checkOutDate, setCheckOutDate] = useState(booking.checkOutDate);
  const [adults, setAdults] = useState(String(booking.adults));
  const [children, setChildren] = useState(String(booking.children));
  const [notes, setNotes] = useState(booking.notes);
  const update = useSend<BookingDto, object>('patch', `/bookings/${booking.id}`, ['/bookings']);
  const inHouse = booking.status === 'checked_in';

  return (
    <form
      className="space-y-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        update.mutate(
          {
            ...(inHouse ? {} : { checkInDate }),
            checkOutDate,
            adults: Number(adults),
            children: Number(children),
            notes,
          },
          {
            onSuccess: () => {
              toast.success('Booking updated');
              onDone();
            },
          },
        );
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Check-in"
          type="date"
          value={checkInDate}
          onChange={(e) => setCheckInDate(e.target.value)}
          disabled={inHouse}
          required
        />
        <TextField
          label="Check-out"
          type="date"
          value={checkOutDate}
          onChange={(e) => setCheckOutDate(e.target.value)}
          required
        />
        <TextField
          label="Adults"
          type="number"
          min={1}
          value={adults}
          onChange={(e) => setAdults(e.target.value)}
          required
        />
        <TextField
          label="Children"
          type="number"
          min={0}
          value={children}
          onChange={(e) => setChildren(e.target.value)}
        />
      </div>
      <TextAreaField
        label="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        maxLength={500}
      />
      {update.isError && <ErrorNotice error={update.error} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={update.isPending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

function BookingDialog({ booking, onClose }: { booking: BookingDto; onClose: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'view' | 'edit' | 'cancel'>('view');
  const invalidate = ['/bookings', '/rooms'];
  const confirm = useSend<BookingDto, void>('post', `/bookings/${booking.id}/confirm`, invalidate);
  const checkIn = useSend<BookingDto, void>('post', `/bookings/${booking.id}/check-in`, invalidate);
  const noShow = useSend<BookingDto, void>('post', `/bookings/${booking.id}/no-show`, invalidate);
  const run = (
    mutation: {
      mutate: (v: undefined, o: { onSuccess: () => void; onError: (e: Error) => void }) => void;
    },
    done: string,
  ) =>
    mutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(done);
        onClose();
      },
      onError: (error) => toast.error(errorText(error)),
    });

  const holding = ['pending', 'confirmed', 'checked_in'].includes(booking.status);

  return (
    <Dialog title={`Booking ${booking.bookingCode}`} onClose={onClose}>
      {mode === 'edit' ? (
        <EditForm booking={booking} onDone={onClose} onBack={() => setMode('view')} />
      ) : mode === 'cancel' ? (
        <CancelForm booking={booking} onDone={onClose} onBack={() => setMode('view')} />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <StatusBadge status={booking.status} />
            <span className="text-sm text-slate-600">
              {booking.guest.name} · {booking.guest.phone}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Room</dt>
            <dd>
              {booking.roomNumber} ({booking.roomTypeName})
            </dd>
            <dt className="text-slate-500">Stay</dt>
            <dd>
              {dateLabel(booking.checkInDate)} → {dateLabel(booking.checkOutDate)} ({booking.nights}{' '}
              nights)
            </dd>
            <dt className="text-slate-500">Guests</dt>
            <dd>
              {booking.adults} adults, {booking.children} children
            </dd>
            <dt className="text-slate-500">Room charge</dt>
            <dd>
              {money(booking.roomTotalPaise)}{' '}
              <span className="text-slate-500">({money(booking.nightlyRatePaise)} a night)</span>
            </dd>
            {booking.notes && (
              <>
                <dt className="text-slate-500">Notes</dt>
                <dd>{booking.notes}</dd>
              </>
            )}
            {booking.cancelReason && (
              <>
                <dt className="text-slate-500">Cancelled because</dt>
                <dd>{booking.cancelReason}</dd>
              </>
            )}
          </dl>
          <p className="rounded-md bg-slate-50 p-2 text-xs text-slate-600">
            The guest&rsquo;s Booking ID is <strong>{booking.bookingCode}</strong>. Give it to them
            at check-in.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            {booking.status === 'pending' && (
              <Button
                onClick={() => run(confirm, 'Booking confirmed')}
                disabled={confirm.isPending}
              >
                Confirm
              </Button>
            )}
            {booking.status === 'confirmed' && (
              <Button onClick={() => run(checkIn, 'Guest checked in')} disabled={checkIn.isPending}>
                Check in
              </Button>
            )}
            {booking.status === 'confirmed' && (
              <Button
                variant="secondary"
                onClick={() => run(noShow, 'Marked as no-show')}
                disabled={noShow.isPending}
              >
                No-show
              </Button>
            )}
            {holding && (
              <Button variant="secondary" onClick={() => setMode('edit')}>
                Change dates
              </Button>
            )}
            {(booking.status === 'pending' || booking.status === 'confirmed') && (
              <Button variant="danger" onClick={() => setMode('cancel')}>
                Cancel booking
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function BookingsPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const bookings = useList<BookingDto>('/bookings', {
    q: q.trim().length >= 2 ? q.trim() : undefined,
    status: status || undefined,
    page,
    limit: 20,
  });
  useRefetchOnEvents(['booking.changed'], [['/bookings']]);

  // The dialog reads the booking from the live list, so it never shows actions that no longer apply.
  const open = bookings.items.find((booking) => booking.id === openId) ?? null;
  const total = bookings.meta?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 20));

  return (
    <div>
      <PageHeader
        title="Bookings"
        actions={
          <Link
            to="/bookings/new"
            className="rounded-md bg-teal-800 px-4 py-2 text-sm font-medium text-white hover:bg-teal-900"
          >
            New booking
          </Link>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <TextField
          label="Search"
          placeholder="Booking ID, guest name or phone"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All</option>
          {['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'].map(
            (value) => (
              <option key={value} value={value}>
                {value.replace('_', ' ')}
              </option>
            ),
          )}
        </SelectField>
      </div>

      <Async query={bookings}>
        {bookings.items.length === 0 ? (
          <EmptyState>No bookings match.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-stone-200">
            <table className="min-w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2">Booking ID</th>
                  <th className="px-4 py-2">Guest</th>
                  <th className="px-4 py-2">Room</th>
                  <th className="px-4 py-2">Stay</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {bookings.items.map((booking) => (
                  <tr key={booking.id}>
                    <td className="px-4 py-2 font-mono">
                      <button
                        type="button"
                        className="text-teal-800 underline-offset-2 hover:underline"
                        onClick={() => setOpenId(booking.id)}
                      >
                        {booking.bookingCode}
                      </button>
                    </td>
                    <td className="px-4 py-2">{booking.guest.name}</td>
                    <td className="px-4 py-2">{booking.roomNumber}</td>
                    <td className="px-4 py-2">
                      {dateLabel(booking.checkInDate)} → {dateLabel(booking.checkOutDate)}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={booking.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
          <span>
            <Badge>{total}</Badge> bookings
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              small
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span>
              Page {page} of {pages}
            </span>
            <Button
              variant="secondary"
              small
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </Async>

      {open && <BookingDialog booking={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}
