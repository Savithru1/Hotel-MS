import type { RoomTypeDto } from '@hospitality/shared-types';
import { useState, type FormEvent } from 'react';
import {
  Async,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  PageHeader,
  TextField,
  money,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useList, useSend } from '../../hooks/queries';

/** Rupees typed by a person become whole paise. Anything that is not a clean amount is refused. */
export function rupeesToPaise(text: string): number | null {
  const value = Number(text.replace(/,/g, '').trim());
  if (!Number.isFinite(value) || value < 0) return null;
  const paise = Math.round(value * 100);
  return Math.abs(paise - value * 100) < 1e-6 ? paise : null;
}

function RoomTypeForm({ type, onClose }: { type?: RoomTypeDto; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(type?.name ?? '');
  const [capacity, setCapacity] = useState(String(type?.capacity ?? 2));
  const [rate, setRate] = useState(type ? String(type.ratePaise / 100) : '');
  const [amenities, setAmenities] = useState(type?.amenities.join(', ') ?? '');
  const save = useSend<RoomTypeDto, object>(
    type ? 'patch' : 'post',
    type ? `/room-types/${type.id}` : '/room-types',
    ['/room-types', '/rooms'],
  );
  const paise = rupeesToPaise(rate);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (paise === null) return;
    save.mutate(
      {
        name,
        capacity: Number(capacity),
        ratePaise: paise,
        amenities: amenities
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
      },
      {
        onSuccess: () => {
          toast.success('Room type saved');
          onClose();
        },
      },
    );
  }

  return (
    <Dialog title={type ? `Edit ${type.name}` : 'New room type'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          required
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Sleeps"
            type="number"
            min={1}
            max={20}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            required
          />
          <TextField
            label="Nightly rate (₹)"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            error={rate && paise === null ? 'Enter an amount like 2500 or 2500.50' : undefined}
            required
          />
        </div>
        <TextField
          label="Amenities"
          hint="Separate with commas"
          value={amenities}
          onChange={(e) => setAmenities(e.target.value)}
        />
        {save.isError && <ErrorNotice error={save.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending || paise === null || !name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RoomTypesPage() {
  const types = useList<RoomTypeDto>('/room-types');
  const toast = useToast();
  const [editing, setEditing] = useState<RoomTypeDto | 'new' | null>(null);
  const toggle = useSend<RoomTypeDto, { id: string; active: boolean }>(
    'patch',
    (body) => `/room-types/${body.id}`,
    ['/room-types'],
  );

  return (
    <div>
      <PageHeader
        title="Room types"
        subtitle="Tariffs are per night, before GST"
        actions={<Button onClick={() => setEditing('new')}>New room type</Button>}
      />
      <Async query={types}>
        {types.items.length === 0 ? (
          <EmptyState>No room types yet. Add one to start adding rooms.</EmptyState>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {types.items.map((type) => (
              <li key={type.id} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
                <div className="flex items-start justify-between">
                  <h2 className="font-serif text-lg">{type.name}</h2>
                  {!type.active && <Badge>Switched off</Badge>}
                </div>
                <p className="mt-1 text-2xl text-slate-900">
                  {money(type.ratePaise)}
                  <span className="text-sm text-slate-500"> / night</span>
                </p>
                <p className="text-sm text-slate-600">Sleeps {type.capacity}</p>
                {type.amenities.length > 0 && (
                  <p className="mt-2 text-xs text-slate-500">{type.amenities.join(' · ')}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <Button variant="secondary" small onClick={() => setEditing(type)}>
                    Edit
                  </Button>
                  <Button
                    variant="quiet"
                    small
                    disabled={toggle.isPending}
                    onClick={() =>
                      toggle.mutate(
                        { id: type.id, active: !type.active },
                        { onError: (e) => toast.error(e.message) },
                      )
                    }
                  >
                    {type.active ? 'Switch off' : 'Switch on'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Async>
      {editing && (
        <RoomTypeForm
          {...(editing === 'new' ? {} : { type: editing })}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
