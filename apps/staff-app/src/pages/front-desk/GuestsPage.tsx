import { GUEST_ID_TYPES } from '@hospitality/constants';
import type { GuestDto, GuestIdDetailsDto } from '@hospitality/shared-types';
import { normalizePhone } from '@hospitality/validation';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import {
  Async,
  Button,
  Dialog,
  EmptyState,
  ErrorNotice,
  PageHeader,
  SelectField,
  TextField,
  errorText,
  words,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useApi } from '../../api/ApiContext';
import { useList, useSend } from '../../hooks/queries';

function GuestForm({
  guest,
  onDone,
  onBack,
}: {
  guest?: GuestDto;
  onDone: () => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(guest?.name ?? '');
  const [phone, setPhone] = useState(guest?.phone ?? '');
  const [email, setEmail] = useState(guest?.email ?? '');
  const [gstin, setGstin] = useState(guest?.gstin ?? '');
  const [idType, setIdType] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const save = useSend<GuestDto, object>(
    guest ? 'patch' : 'post',
    guest ? `/guests/${guest.id}` : '/guests',
    ['/guests'],
  );
  const valid = normalizePhone(phone) !== null;

  function submit(event: FormEvent): void {
    event.preventDefault();
    save.mutate(
      {
        name,
        phone,
        email: email || (guest ? null : undefined),
        gstin: gstin || (guest ? null : undefined),
        ...(idType && idNumber ? { idDetails: { idType, idNumber } } : {}),
      },
      {
        onSuccess: () => {
          toast.success(guest ? 'Guest updated' : 'Guest added');
          onDone();
        },
      },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <TextField
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
        required
      />
      <TextField
        label="Phone"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        error={phone && !valid ? 'Not a valid phone number' : undefined}
        hint="Saved in international form, for example +919876543210"
        required
      />
      <TextField
        label="Email (optional)"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <TextField
        label="GSTIN (optional, for business stays)"
        value={gstin}
        onChange={(e) => setGstin(e.target.value.toUpperCase())}
        maxLength={15}
      />
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label={guest?.hasIdDetails ? 'Replace ID type' : 'ID type (optional)'}
          value={idType}
          onChange={(e) => setIdType(e.target.value)}
        >
          <option value="">None</option>
          {GUEST_ID_TYPES.map((type) => (
            <option key={type} value={type}>
              {words(type)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="ID number"
          value={idNumber}
          onChange={(e) => setIdNumber(e.target.value)}
          disabled={!idType}
          maxLength={30}
        />
      </div>
      {save.isError && <ErrorNotice error={save.error} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={save.isPending || !valid || !name.trim()}>
          Save guest
        </Button>
      </div>
    </form>
  );
}

function GuestProfile({ guest, onClose }: { guest: GuestDto; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [id, setId] = useState<GuestIdDetailsDto | null>(null);

  async function showId(): Promise<void> {
    try {
      setId((await api.get<GuestIdDetailsDto>(`/guests/${guest.id}/id-details`)).data);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : errorText(error));
    }
  }

  return (
    <Dialog title={guest.name} onClose={onClose}>
      {editing ? (
        <GuestForm guest={guest} onDone={onClose} onBack={() => setEditing(false)} />
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Phone</dt>
            <dd>{guest.phone}</dd>
            <dt className="text-slate-500">Email</dt>
            <dd>{guest.email ?? '—'}</dd>
            <dt className="text-slate-500">GSTIN</dt>
            <dd>{guest.gstin ?? '—'}</dd>
            <dt className="text-slate-500">ID document</dt>
            <dd>
              {id ? (
                <span>
                  {words(id.idType)}: <strong>{id.idNumber}</strong>
                </span>
              ) : guest.hasIdDetails ? (
                <Button variant="quiet" small onClick={() => void showId()}>
                  Show (this is logged)
                </Button>
              ) : (
                '—'
              )}
            </dd>
          </dl>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function GuestsPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<GuestDto | 'new' | null>(null);
  const guests = useList<GuestDto>('/guests', {
    q: q.trim().length >= 2 ? q.trim() : undefined,
    page,
    limit: 20,
  });
  const total = guests.meta?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 20));

  return (
    <div>
      <PageHeader
        title="Guests"
        actions={<Button onClick={() => setOpen('new')}>Add guest</Button>}
      />
      <div className="mb-4 max-w-sm">
        <TextField
          label="Search"
          placeholder="Name, phone or email"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <Async query={guests}>
        {guests.items.length === 0 ? (
          <EmptyState>
            {q ? 'No guest matches.' : 'No guests yet. They are added here or while booking.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-stone-100 rounded-lg bg-white shadow-sm ring-1 ring-stone-200">
            {guests.items.map((guest) => (
              <li key={guest.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <button
                    type="button"
                    className="font-medium text-teal-800 hover:underline"
                    onClick={() => setOpen(guest)}
                  >
                    {guest.name}
                  </button>
                  <p className="text-xs text-slate-500">
                    {guest.phone}
                    {guest.email ? ` · ${guest.email}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex items-center justify-end gap-2 text-sm text-slate-600">
          <Button variant="secondary" small disabled={page <= 1} onClick={() => setPage(page - 1)}>
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
      </Async>
      {open === 'new' && (
        <Dialog title="Add guest" onClose={() => setOpen(null)}>
          <GuestForm onDone={() => setOpen(null)} onBack={() => setOpen(null)} />
        </Dialog>
      )}
      {open && open !== 'new' && <GuestProfile guest={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
