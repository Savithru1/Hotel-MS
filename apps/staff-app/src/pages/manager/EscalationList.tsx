import type { OverviewEscalationDto } from '@hospitality/shared-types';
import { useState } from 'react';
import { Badge, Button, Card, EmptyState, errorText, timeLabel } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useSend } from '../../hooks/queries';
import { AssignDialog } from './AssignDialog';

const KIND_LABEL = { housekeeping: 'Housekeeping', maintenance: 'Maintenance' } as const;

function EscalationRow({
  item,
  onAssign,
}: {
  item: OverviewEscalationDto;
  onAssign: (item: OverviewEscalationDto) => void;
}) {
  const toast = useToast();
  const acknowledge = useSend<unknown, void>('post', `/${item.kind}/${item.id}/acknowledge`, [
    '/manager',
    '/housekeeping',
    '/maintenance',
  ]);
  const where = item.roomNumber ? `room ${item.roomNumber}` : 'no room';
  const urgent = item.priority === 'urgent' || item.priority === 'high';

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-900">
          {item.roomNumber ? `Room ${item.roomNumber}` : 'No room'} · {KIND_LABEL[item.kind]}{' '}
          {urgent && <Badge tone="bad">{item.priority}</Badge>}
        </p>
        {item.reason && <p className="text-sm text-slate-700">{item.reason}</p>}
        {item.escalatedAt && (
          <p className="text-xs text-slate-500">Escalated at {timeLabel(item.escalatedAt)}</p>
        )}
      </div>
      <div className="flex gap-1">
        <Button
          small
          aria-label={`Assign or reassign ${item.kind} task, ${where}`}
          onClick={() => onAssign(item)}
        >
          Assign / reassign
        </Button>
        <Button
          small
          variant="quiet"
          disabled={acknowledge.isPending}
          aria-label={`Clear escalation, ${item.kind} task, ${where}`}
          onClick={() =>
            acknowledge.mutate(undefined, { onError: (e) => toast.error(errorText(e)) })
          }
        >
          Clear escalation
        </Button>
      </div>
    </li>
  );
}

/** Work somebody escalated, with the two things a manager does about it. */
export function EscalationList({ items }: { items: OverviewEscalationDto[] }) {
  const [assigning, setAssigning] = useState<OverviewEscalationDto | null>(null);
  return (
    <Card title="Escalations">
      {items.length === 0 ? (
        <EmptyState>Nothing is escalated right now.</EmptyState>
      ) : (
        <ul className="divide-y divide-stone-100">
          {items.map((item) => (
            <EscalationRow key={`${item.kind}-${item.id}`} item={item} onAssign={setAssigning} />
          ))}
        </ul>
      )}
      {assigning && <AssignDialog escalation={assigning} onClose={() => setAssigning(null)} />}
    </Card>
  );
}
