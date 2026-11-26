import { MAX_FACILITY_CAPACITY } from '@hospitality/constants';
import type {
  FacilityBookingDto,
  FacilityDto,
  FacilitySlotDto,
  RoomDto,
} from '@hospitality/shared-types';
import { useState } from 'react';
import {
  Async,
  Button,
  Dialog,
  ErrorNotice,
  SelectField,
  Spinner,
  TextField,
  money,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useGet, useList, useSend } from '../../hooks/queries';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function slotNote(slot: FacilitySlotDto): string {
  if (slot.past) return 'Started';
  if (slot.remaining === 0) return 'Full';
  return `${slot.remaining} left`;
}

/** Spa staff or the front desk book a slot for the guest in a room. The server sets the price. */
export function NewFacilityBookingDialog({ day, onClose }: { day: string; onClose: () => void }) {
  const toast = useToast();
  const rooms = useList<RoomDto>('/rooms', { limit: 100 });
  const facilities = useList<FacilityDto>('/facilities', { limit: 100 });
  const create = useSend<FacilityBookingDto, object>('post', '/facility-bookings', [
    '/facility-bookings',
  ]);

  const [chosenRoom, setChosenRoom] = useState<string | null>(null);
  const [chosenFacility, setChosenFacility] = useState<string | null>(null);
  const [date, setDate] = useState(day);
  const [startTime, setStartTime] = useState<string | null>(null);
  const [people, setPeople] = useState('1');
  const [notes, setNotes] = useState('');

  const occupied = rooms.items.filter((room) => room.status === 'occupied');
  const open = facilities.items.filter((facility) => facility.active);
  // Until the person picks, the first room with a guest and the first open facility are selected.
  const roomId = chosenRoom ?? occupied[0]?.id ?? '';
  const facilityId = chosenFacility ?? open[0]?.id ?? '';
  const slots = useGet<FacilitySlotDto[]>(
    `/facilities/${facilityId}/slots`,
    { date },
    { enabled: facilityId !== '' && DATE_ONLY.test(date) },
  );

  const count = Number(people);
  const countOk = Number.isInteger(count) && count >= 1 && count <= MAX_FACILITY_CAPACITY;
  const canBook = roomId !== '' && facilityId !== '' && startTime !== null && countOk;

  return (
    <Dialog title="Book a facility" onClose={onClose}>
      <div className="space-y-4">
        <Async query={rooms}>
          <SelectField
            label="Room"
            value={roomId}
            onChange={(event) => setChosenRoom(event.target.value)}
          >
            {occupied.length === 0 && <option value="">No room has a guest checked in</option>}
            {occupied.map((room) => (
              <option key={room.id} value={room.id}>
                Room {room.number}
              </option>
            ))}
          </SelectField>
        </Async>

        <Async query={facilities}>
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Facility"
              value={facilityId}
              onChange={(event) => {
                setChosenFacility(event.target.value);
                setStartTime(null);
              }}
            >
              {open.length === 0 && <option value="">No facility is open for bookings</option>}
              {open.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Date"
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
                setStartTime(null);
              }}
            />
          </div>
        </Async>

        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Time</p>
          {slots.isPending && facilityId !== '' ? (
            <Spinner label="Loading slots" />
          ) : slots.isError ? (
            <ErrorNotice error={slots.error} onRetry={() => void slots.refetch()} />
          ) : (slots.data?.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No slots on this day.</p>
          ) : (
            <div className="grid max-h-48 grid-cols-3 gap-2 overflow-y-auto pr-1">
              {(slots.data?.data ?? []).map((slot) => (
                <Button
                  key={slot.startTime}
                  variant={startTime === slot.startTime ? 'primary' : 'secondary'}
                  small
                  disabled={!slot.bookable}
                  aria-pressed={startTime === slot.startTime}
                  onClick={() => setStartTime(slot.startTime)}
                >
                  <span className="flex flex-col items-center leading-tight">
                    <span>
                      {slot.startTime}–{slot.endTime}
                    </span>
                    <span className="text-xs font-normal opacity-80">{slotNote(slot)}</span>
                  </span>
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="People"
            type="number"
            min={1}
            max={MAX_FACILITY_CAPACITY}
            value={people}
            onChange={(event) => setPeople(event.target.value)}
          />
          <TextField
            label="Notes (optional)"
            value={notes}
            maxLength={300}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>

        {create.isError && <ErrorNotice error={create.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={create.isPending || !canBook}
            onClick={() =>
              create.mutate(
                {
                  facilityId,
                  roomId,
                  date,
                  startTime,
                  participants: count,
                  notes: notes.trim(),
                },
                {
                  onSuccess: (created) => {
                    toast.success(
                      `Booked ${created.facilityName} for Room ${created.roomNumber} · ${money(created.totalPaise)}`,
                    );
                    onClose();
                  },
                },
              )
            }
          >
            Book
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
