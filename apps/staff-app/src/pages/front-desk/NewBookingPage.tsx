import type { AvailabilityDto, BookingDto, GuestDto } from '@hospitality/shared-types';
import { normalizePhone } from '@hospitality/validation';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Card,
  ErrorNotice,
  PageHeader,
  SelectField,
  Spinner,
  TextAreaField,
  TextField,
  errorText,
  money,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useGet, useList, useSend } from '../../hooks/queries';

const isoDate = (offset: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export function NewBookingPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [checkInDate, setCheckInDate] = useState(isoDate(0));
  const [checkOutDate, setCheckOutDate] = useState(isoDate(1));
  const [adults, setAdults] = useState('1');
  const [children, setChildren] = useState('0');
  const [typeId, setTypeId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<'confirmed' | 'pending'>('confirmed');

  const datesOk = checkOutDate > checkInDate;
  const availability = useGet<AvailabilityDto>(
    '/bookings/availability',
    { checkInDate, checkOutDate },
    { enabled: datesOk },
  );
  const normalized = normalizePhone(phone);
  const existing = useList<GuestDto>('/guests', { q: normalized ?? undefined, limit: 5 });
  const create = useSend<BookingDto, object>('post', '/bookings', ['/bookings', '/rooms']);

  const types = availability.data?.data.roomTypes ?? [];
  const chosen = types.find((type) => type.roomTypeId === typeId);
  const match = normalized ? existing.items.find((guest) => guest.phone === normalized) : undefined;
  const guestReady = Boolean(normalized) && (Boolean(match) || name.trim().length > 0);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!normalized) return;
    create.mutate(
      {
        ...(match
          ? { guestId: match.id }
          : { guest: { name: name.trim(), phone: normalized, ...(email ? { email } : {}) } }),
        roomTypeId: typeId,
        ...(roomId ? { roomId } : {}),
        checkInDate,
        checkOutDate,
        adults: Number(adults),
        children: Number(children),
        notes,
        status,
      },
      {
        onSuccess: (booking) => {
          toast.success(`Booking ${booking.bookingCode} created for room ${booking.roomNumber}`);
          navigate('/bookings');
        },
        onError: (error) => toast.error(errorText(error)),
      },
    );
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="New booking" subtitle="Check what is free, then add the guest" />
      <form onSubmit={submit} className="space-y-6">
        <Card title="1. Dates and guests">
          <div className="grid gap-3 sm:grid-cols-4">
            <TextField
              label="Check-in"
              type="date"
              value={checkInDate}
              onChange={(e) => {
                setCheckInDate(e.target.value);
                setRoomId('');
              }}
              required
            />
            <TextField
              label="Check-out"
              type="date"
              value={checkOutDate}
              onChange={(e) => {
                setCheckOutDate(e.target.value);
                setRoomId('');
              }}
              error={datesOk ? undefined : 'Must be after check-in'}
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
        </Card>

        <Card title="2. Room">
          {!datesOk ? (
            <p className="text-sm text-slate-500">Choose valid dates first.</p>
          ) : availability.isPending ? (
            <Spinner label="Checking availability" />
          ) : availability.isError ? (
            <ErrorNotice error={availability.error} onRetry={() => void availability.refetch()} />
          ) : (
            <div className="space-y-3">
              <fieldset>
                <legend className="sr-only">Room type</legend>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {types.map((type) => {
                    const free = type.availableRooms.length;
                    const fits = Number(adults) + Number(children) <= type.capacity;
                    return (
                      <li key={type.roomTypeId}>
                        <label
                          className={`flex cursor-pointer items-start gap-3 rounded-lg p-3 ring-1 ring-inset ${typeId === type.roomTypeId ? 'bg-teal-50 ring-teal-600' : 'bg-white ring-stone-300'} ${free === 0 || !fits ? 'opacity-50' : ''}`}
                        >
                          <input
                            type="radio"
                            name="roomType"
                            value={type.roomTypeId}
                            checked={typeId === type.roomTypeId}
                            disabled={free === 0 || !fits}
                            onChange={() => {
                              setTypeId(type.roomTypeId);
                              setRoomId('');
                            }}
                          />
                          <span>
                            <span className="block font-medium">{type.roomTypeName}</span>
                            <span className="block text-xs text-slate-600">
                              {money(type.nightlyRatePaise)} a night · sleeps {type.capacity}
                            </span>
                            <span className="block text-xs text-slate-600">
                              {free === 0 ? 'None free' : `${free} free`}
                              {!fits ? ' · too small for this party' : ''}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
              {chosen && (
                <SelectField
                  label="Room"
                  hint="Leave on automatic to let the system pick"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                >
                  <option value="">Automatic</option>
                  {chosen.availableRooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      Room {room.number} (floor {room.floor})
                    </option>
                  ))}
                </SelectField>
              )}
            </div>
          )}
        </Card>

        <Card title="3. Guest">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Phone number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="98765 43210"
              error={phone && !normalized ? 'Not a valid phone number' : undefined}
              required
            />
            {match ? (
              <p className="self-end rounded-md bg-emerald-50 p-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
                Existing guest: <strong>{match.name}</strong>
              </p>
            ) : (
              <TextField
                label="Guest name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                required
              />
            )}
            {!match && (
              <TextField
                label="Email (optional)"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
            <SelectField
              label="Booking status"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'confirmed' | 'pending')}
            >
              <option value="confirmed">Confirmed</option>
              <option value="pending">Pending (not yet confirmed)</option>
            </SelectField>
          </div>
          <div className="mt-3">
            <TextAreaField
              label="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
            />
          </div>
        </Card>

        {create.isError && <ErrorNotice error={create.error} />}
        <div className="flex justify-end">
          <Button type="submit" disabled={create.isPending || !typeId || !guestReady || !datesOk}>
            {create.isPending ? 'Creating…' : 'Create booking'}
          </Button>
        </div>
      </form>
    </div>
  );
}
