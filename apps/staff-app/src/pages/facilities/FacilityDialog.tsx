import { FACILITY_TYPES } from '@hospitality/constants';
import type { FacilityDto } from '@hospitality/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApi } from '../../api/ApiContext';
import { Button, Dialog, SelectField, TextField, errorText, words } from '../../components/ui';
import { useToast } from '../../components/Toast';
import {
  buildFacilityPayload,
  emptyFacilityForm,
  formFromFacility,
  type FacilityFormState,
} from './facility-form';

const typeLabel = (type: string): string => words(type).replace(/^./, (c) => c.toUpperCase());

/** Add a facility, or change one. The server refuses hours or capacity changes while bookings hold slots. */
export function FacilityDialog({
  facility,
  onClose,
}: {
  facility?: FacilityDto;
  onClose: () => void;
}) {
  const api = useApi();
  const queries = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<FacilityFormState>(() =>
    facility ? formFromFacility(facility) : emptyFacilityForm(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = (patch: Partial<FacilityFormState>): void =>
    setForm((current) => ({ ...current, ...patch }));

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const built = buildFacilityPayload(form);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    try {
      if (facility) await api.patch(`/facilities/${facility.id}`, built.value);
      else await api.post('/facilities', built.value);
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
      return;
    }
    await queries.invalidateQueries({
      predicate: (query) => String(query.queryKey[0]).startsWith('/facilit'),
    });
    toast.success(facility ? `Saved ${built.value.name}` : `Added ${built.value.name}`);
    setBusy(false);
    onClose();
  }

  return (
    <Dialog title={facility ? `Edit ${facility.name}` : 'Add a facility'} onClose={onClose}>
      <form onSubmit={(event) => void save(event)} className="space-y-3">
        <TextField
          label="Name"
          value={form.name}
          maxLength={80}
          onChange={(e) => change({ name: e.target.value })}
        />
        <SelectField
          label="Type"
          value={form.type}
          onChange={(e) => change({ type: e.target.value as FacilityFormState['type'] })}
        >
          {FACILITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {typeLabel(type)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Description (optional)"
          value={form.description}
          maxLength={300}
          onChange={(e) => change({ description: e.target.value })}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Capacity (people per slot)"
            inputMode="numeric"
            value={form.capacity}
            onChange={(e) => change({ capacity: e.target.value })}
            hint="1 means one booking at a time."
          />
          <TextField
            label="Slot length (minutes)"
            inputMode="numeric"
            value={form.slotMinutes}
            onChange={(e) => change({ slotMinutes: e.target.value })}
          />
          <TextField
            label="Opens at"
            type="time"
            value={form.opensAt}
            onChange={(e) => change({ opensAt: e.target.value })}
          />
          <TextField
            label="Closes at"
            type="time"
            value={form.closesAt}
            onChange={(e) => change({ closesAt: e.target.value })}
          />
        </div>
        <TextField
          label="Price per person (₹)"
          inputMode="decimal"
          value={form.price}
          onChange={(e) => change({ price: e.target.value })}
          hint="Per slot, before tax. Use 0 for a free facility."
        />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => change({ active: e.target.checked })}
          />
          Open for bookings
        </label>
        {error && (
          <p
            role="alert"
            className="rounded-md bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Save facility
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
