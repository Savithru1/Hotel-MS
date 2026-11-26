import type {
  HousekeepingRequestDto,
  QueueSummaryDto,
  RoomDto,
  StaffDto,
} from '@hospitality/shared-types';
import { useState } from 'react';
import { useStaff } from '../../auth/AuthContext';
import { isManager } from '../../auth/permissions';
import {
  Async,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorNotice,
  PageHeader,
  StatusBadge,
  TextField,
  errorText,
  timeLabel,
  words,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useGet, useList, useSend } from '../../hooks/queries';
import { useRefetchOnEvents } from '../../realtime/RealtimeProvider';
import { HousekeepingRequestDialog } from '../operations/RequestDialogs';

const TYPE_LABEL: Record<string, string> = {
  towels: 'Towels',
  toiletries: 'Toiletries',
  room_cleaning: 'Room cleaning',
  pillows_blankets: 'Pillows and blankets',
  other: 'Other',
};

function ReasonDialog({
  title,
  prompt,
  confirm,
  onSubmit,
  onClose,
  busy,
  error,
}: {
  title: string;
  prompt: string;
  confirm: string;
  onSubmit: (reason: string) => void;
  onClose: () => void;
  busy: boolean;
  error: unknown;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(reason);
        }}
      >
        <TextField
          label={prompt}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          required
        />
        {error !== null && error !== undefined && <ErrorNotice error={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button type="submit" disabled={busy || reason.trim().length < 3}>
            {confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RequestCard({
  request,
  housekeepers,
}: {
  request: HousekeepingRequestDto;
  housekeepers: StaffDto[];
}) {
  const { staff } = useStaff();
  const toast = useToast();
  const [dialog, setDialog] = useState<'escalate' | 'cancel' | null>(null);
  const base = `/housekeeping/${request.id}`;
  const refresh = ['/housekeeping', '/rooms'];
  const start = useSend<HousekeepingRequestDto, void>('post', `${base}/start`, refresh);
  const complete = useSend<HousekeepingRequestDto, object>('post', `${base}/complete`, refresh);
  const assign = useSend<HousekeepingRequestDto, { staffId: string }>(
    'post',
    `${base}/assign`,
    refresh,
  );
  const escalate = useSend<HousekeepingRequestDto, { reason: string }>(
    'post',
    `${base}/escalate`,
    refresh,
  );
  const cancel = useSend<HousekeepingRequestDto, { reason: string }>(
    'post',
    `${base}/cancel`,
    refresh,
  );
  const acknowledge = useSend<HousekeepingRequestDto, void>('post', `${base}/acknowledge`, refresh);

  const works = staff.role === 'housekeeping' || isManager(staff.role);
  // Someone else's task is theirs to start and finish (a manager can still step in).
  const mayWork =
    works && (isManager(staff.role) || !request.assignedTo || request.assignedTo.id === staff.id);
  const desk = staff.role === 'front_desk' || isManager(staff.role);
  const open = request.status === 'new' || request.status === 'in_progress';
  const fail = (error: unknown): void => toast.error(errorText(error));

  return (
    <li
      className={`rounded-lg p-3 ring-1 ring-inset ${
        request.escalated ? 'bg-rose-50 ring-rose-300' : 'bg-white ring-stone-200'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            Room {request.roomNumber} · {TYPE_LABEL[request.type] ?? words(request.type)}
          </p>
          <p className="text-xs text-slate-500">
            {request.guestName ? `${request.guestName} · ` : ''}
            {timeLabel(request.createdAt)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={request.status} />
          {request.priority === 'urgent' && <Badge tone="bad">Urgent</Badge>}
        </div>
      </div>
      {request.notes && <p className="mt-2 text-sm text-slate-700">{request.notes}</p>}
      {request.assignedTo && (
        <p className="mt-1 text-xs text-slate-500">Assigned to {request.assignedTo.name}</p>
      )}
      {request.escalated && (
        <p className="mt-2 text-sm font-medium text-rose-800">
          Escalated: {request.escalationReason}
        </p>
      )}

      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {mayWork && request.status === 'new' && (
            <Button
              small
              disabled={start.isPending}
              onClick={() => start.mutate(undefined, { onError: fail })}
            >
              Start
            </Button>
          )}
          {mayWork && request.status === 'in_progress' && (
            <Button
              small
              disabled={complete.isPending}
              onClick={() => complete.mutate({}, { onError: fail })}
            >
              Complete
            </Button>
          )}
          {isManager(staff.role) && request.status === 'new' && housekeepers.length > 0 && (
            <select
              aria-label={`Assign request for room ${request.roomNumber}`}
              className="rounded-md border-0 bg-white py-1 pl-2 pr-7 text-sm ring-1 ring-inset ring-slate-300"
              value={request.assignedTo?.id ?? ''}
              onChange={(event) =>
                event.target.value &&
                assign.mutate({ staffId: event.target.value }, { onError: fail })
              }
            >
              <option value="">Assign to…</option>
              {housekeepers.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          )}
          {!request.escalated && (
            <Button variant="quiet" small onClick={() => setDialog('escalate')}>
              Escalate
            </Button>
          )}
          {request.escalated && desk && (
            <Button
              variant="quiet"
              small
              onClick={() => acknowledge.mutate(undefined, { onError: fail })}
            >
              Clear escalation
            </Button>
          )}
          {desk && request.status === 'new' && (
            <Button variant="quiet" small onClick={() => setDialog('cancel')}>
              Cancel request
            </Button>
          )}
        </div>
      )}

      {dialog === 'escalate' && (
        <ReasonDialog
          title="Escalate to the front desk and managers"
          prompt="Why does this need attention?"
          confirm="Escalate"
          busy={escalate.isPending}
          error={escalate.error}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => escalate.mutate({ reason }, { onSuccess: () => setDialog(null) })}
        />
      )}
      {dialog === 'cancel' && (
        <ReasonDialog
          title="Cancel this request"
          prompt="Reason"
          confirm="Cancel request"
          busy={cancel.isPending}
          error={cancel.error}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => cancel.mutate({ reason }, { onSuccess: () => setDialog(null) })}
        />
      )}
    </li>
  );
}

function Column({
  title,
  count,
  items,
  housekeepers,
  empty,
}: {
  title: string;
  count: number;
  items: HousekeepingRequestDto[];
  housekeepers: StaffDto[];
  empty: string;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
        {title} <Badge>{count}</Badge>
      </h2>
      {items.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="space-y-2">
          {items.map((request) => (
            <RequestCard key={request.id} request={request} housekeepers={housekeepers} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function HousekeepingPage() {
  const { staff } = useStaff();
  const [creating, setCreating] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const canLog = staff.role !== 'maintenance';

  const open = useList<HousekeepingRequestDto>('/housekeeping', {
    open: true,
    limit: 100,
    ...(mineOnly ? { mine: true } : {}),
  });
  const done = useList<HousekeepingRequestDto>('/housekeeping', { status: 'completed', limit: 10 });
  const summary = useGet<QueueSummaryDto>('/housekeeping/summary');
  const rooms = useList<RoomDto>('/rooms', { limit: 100 });
  const people = useGet<StaffDto[]>(
    '/staff',
    { role: 'housekeeping', active: true, limit: 100 },
    { enabled: isManager(staff.role) },
  );

  useRefetchOnEvents(['housekeeping.changed'], [['/housekeeping'], ['/housekeeping/summary']]);

  const housekeepers = people.data?.data ?? [];
  const fresh = open.items.filter((request) => request.status === 'new');
  const working = open.items.filter((request) => request.status === 'in_progress');

  return (
    <div>
      <PageHeader
        title="Housekeeping"
        subtitle="Requests and cleaning tasks, updated live"
        actions={
          <>
            {staff.role === 'housekeeping' && (
              <Button
                variant="secondary"
                onClick={() => setMineOnly((value) => !value)}
                aria-pressed={mineOnly}
              >
                {mineOnly ? 'Showing my tasks' : 'Show only my tasks'}
              </Button>
            )}
            {canLog && <Button onClick={() => setCreating(true)}>Log request</Button>}
          </>
        }
      />

      {summary.data && (
        <p className="mb-4 text-sm text-slate-600">
          {summary.data.data.urgent} urgent open · {summary.data.data.escalated} escalated
        </p>
      )}

      <Async query={open}>
        <div className="grid gap-6 lg:grid-cols-3">
          <Column
            title="New"
            count={fresh.length}
            items={fresh}
            housekeepers={housekeepers}
            empty="Nothing waiting."
          />
          <Column
            title="In progress"
            count={working.length}
            items={working}
            housekeepers={housekeepers}
            empty="Nothing in progress."
          />
          <Column
            title="Completed (latest)"
            count={done.items.length}
            items={done.items}
            housekeepers={housekeepers}
            empty="Nothing completed yet."
          />
        </div>
      </Async>

      {creating && (
        <HousekeepingRequestDialog rooms={rooms.items} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

export { Card };
