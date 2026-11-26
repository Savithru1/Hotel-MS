import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRIORITIES,
  SERVICE_REQUEST_TYPES,
} from '@hospitality/constants';
import type { HousekeepingRequestDto, MaintenanceIssueDto } from '@hospitality/shared-types';
import { useState, type FormEvent } from 'react';
import {
  Button,
  Dialog,
  ErrorNotice,
  SelectField,
  TextAreaField,
  TextField,
  words,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useSend } from '../../hooks/queries';

/** The rooms offered in the pickers: a number to show and an id to send. */
export interface RoomOption {
  id: string;
  number: string;
}

const label = (value: string): string => words(value).replace(/^./, (c) => c.toUpperCase());

export function HousekeepingRequestDialog({
  rooms,
  roomId,
  onClose,
}: {
  rooms: RoomOption[];
  roomId?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [room, setRoom] = useState(roomId ?? rooms[0]?.id ?? '');
  const [type, setType] = useState<string>('room_cleaning');
  const [priority, setPriority] = useState('normal');
  const [notes, setNotes] = useState('');
  const create = useSend<HousekeepingRequestDto, object>('post', '/housekeeping', [
    '/housekeeping',
  ]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    create.mutate(
      { roomId: room, type, priority, notes },
      {
        onSuccess: () => {
          toast.success('Housekeeping request logged');
          onClose();
        },
      },
    );
  }

  return (
    <Dialog title="Log a housekeeping request" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <SelectField
          label="Room"
          value={room}
          onChange={(e) => setRoom(e.target.value)}
          disabled={Boolean(roomId)}
        >
          {rooms.map((option) => (
            <option key={option.id} value={option.id}>
              Room {option.number}
            </option>
          ))}
        </SelectField>
        <SelectField label="What is needed" value={type} onChange={(e) => setType(e.target.value)}>
          {SERVICE_REQUEST_TYPES.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        >
          <option value="normal">Normal</option>
          <option value="urgent">Urgent</option>
        </SelectField>
        <TextAreaField
          label="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
        />
        {create.isError && <ErrorNotice error={create.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !room}>
            Log request
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function MaintenanceIssueDialog({
  rooms,
  roomId,
  onClose,
}: {
  rooms: RoomOption[];
  roomId?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [room, setRoom] = useState(roomId ?? rooms[0]?.id ?? '');
  const [category, setCategory] = useState<string>('air_conditioning');
  const [priority, setPriority] = useState('medium');
  const [description, setDescription] = useState('');
  const [outOfService, setOutOfService] = useState(false);
  const create = useSend<MaintenanceIssueDto, object>('post', '/maintenance', [
    '/maintenance',
    '/rooms',
    '/bookings/overview',
  ]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    create.mutate(
      { roomId: room, category, priority, description, takeRoomOutOfService: outOfService },
      {
        onSuccess: () => {
          toast.success('Issue reported');
          onClose();
        },
      },
    );
  }

  return (
    <Dialog title="Report a maintenance issue" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <SelectField
          label="Room"
          value={room}
          onChange={(e) => setRoom(e.target.value)}
          disabled={Boolean(roomId)}
        >
          {rooms.map((option) => (
            <option key={option.id} value={option.id}>
              Room {option.number}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Problem with"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          {MAINTENANCE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        >
          {MAINTENANCE_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="What is wrong"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          required
        />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={outOfService}
            onChange={(e) => setOutOfService(e.target.checked)}
          />
          Take the room out of service until this is fixed
        </label>
        {create.isError && <ErrorNotice error={create.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={create.isPending || !room || description.trim().length < 3}
          >
            Report issue
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
