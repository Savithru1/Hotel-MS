import type { FacilityDto } from '@hospitality/shared-types';
import { useState } from 'react';
import {
  Async,
  Badge,
  Button,
  EmptyState,
  PageHeader,
  errorText,
  money,
  words,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useList, useSend } from '../../hooks/queries';
import { FacilityDialog } from './FacilityDialog';

const typeLabel = (type: string): string => words(type).replace(/^./, (c) => c.toUpperCase());

function FacilityRow({
  facility,
  onEdit,
}: {
  facility: FacilityDto;
  onEdit: (facility: FacilityDto) => void;
}) {
  const toast = useToast();
  const toggle = useSend<FacilityDto, { active: boolean }>('patch', `/facilities/${facility.id}`, [
    '/facilit',
  ]);

  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-900">{facility.name}</span>
          <Badge tone="info">{typeLabel(facility.type)}</Badge>
          {!facility.active && <Badge tone="warn">Closed</Badge>}
        </div>
        {facility.description && <p className="text-sm text-slate-600">{facility.description}</p>}
        <p className="mt-1 flex flex-wrap gap-x-3 text-sm text-slate-700">
          <span>
            {facility.opensAt}–{facility.closesAt}
          </span>
          <span>{facility.slotMinutes} min slots</span>
          <span>
            {facility.capacity === 1
              ? 'One booking at a time'
              : `Up to ${facility.capacity} people per slot`}
          </span>
          <span>{money(facility.pricePaise)}</span>
          <span className="text-slate-500">per person</span>
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        <Button
          variant="secondary"
          small
          disabled={toggle.isPending}
          aria-label={
            facility.active
              ? `Close ${facility.name} for bookings`
              : `Open ${facility.name} for bookings`
          }
          onClick={() =>
            toggle.mutate(
              { active: !facility.active },
              { onError: (error) => toast.error(errorText(error)) },
            )
          }
        >
          {facility.active ? 'Close' : 'Open'}
        </Button>
        <Button
          variant="quiet"
          small
          aria-label={`Edit ${facility.name}`}
          onClick={() => onEdit(facility)}
        >
          Edit
        </Button>
      </div>
    </li>
  );
}

/** The facilities editor: managers set up the spa, pool, gym and activities guests can book. */
export function FacilitiesPage() {
  const list = useList<FacilityDto>('/facilities', { limit: 100 });
  const [editing, setEditing] = useState<FacilityDto | 'new' | null>(null);

  return (
    <div>
      <PageHeader
        title="Facilities"
        subtitle="What guests can book by the slot. Prices are per person, before tax."
        actions={<Button onClick={() => setEditing('new')}>Add facility</Button>}
      />
      {list.meta && list.meta.total > list.items.length && (
        <p className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
          Showing the first {list.items.length} of {list.meta.total} facilities. The rest are not
          shown here yet.
        </p>
      )}
      <Async query={list}>
        {list.items.length === 0 ? (
          <EmptyState>No facilities yet. Add the first one.</EmptyState>
        ) : (
          <ul className="divide-y divide-stone-100">
            {list.items.map((facility) => (
              <FacilityRow key={facility.id} facility={facility} onEdit={setEditing} />
            ))}
          </ul>
        )}
      </Async>
      {editing && (
        <FacilityDialog
          {...(editing === 'new' ? {} : { facility: editing })}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
