import type {
  MaintenanceIssueDto,
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
import { MaintenanceIssueDialog } from '../operations/RequestDialogs';

const PRIORITY_TONE = { low: 'neutral', medium: 'info', high: 'warn', urgent: 'bad' } as const;

function TextDialog({
  title,
  prompt,
  confirm,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  prompt: string;
  confirm: string;
  busy: boolean;
  error: unknown;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(text);
        }}
      >
        <TextField
          label={prompt}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={300}
          required
        />
        {error !== null && error !== undefined && <ErrorNotice error={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button type="submit" disabled={busy || text.trim().length < 3}>
            {confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function IssueCard({
  issue,
  technicians,
}: {
  issue: MaintenanceIssueDto;
  technicians: StaffDto[];
}) {
  const { staff } = useStaff();
  const toast = useToast();
  const [dialog, setDialog] = useState<'resolve' | 'escalate' | null>(null);
  const base = `/maintenance/${issue.id}`;
  const refresh = ['/maintenance', '/rooms'];
  const assign = useSend<MaintenanceIssueDto, { staffId: string }>(
    'post',
    `${base}/assign`,
    refresh,
  );
  const start = useSend<MaintenanceIssueDto, void>('post', `${base}/start`, refresh);
  const resolve = useSend<MaintenanceIssueDto, { resolutionNote: string }>(
    'post',
    `${base}/resolve`,
    refresh,
  );
  const escalate = useSend<MaintenanceIssueDto, { reason: string }>(
    'post',
    `${base}/escalate`,
    refresh,
  );
  const acknowledge = useSend<MaintenanceIssueDto, void>('post', `${base}/acknowledge`, refresh);

  const manager = isManager(staff.role);
  const technician = staff.role === 'maintenance';
  const mine = issue.assignedTo?.id === staff.id;
  const open = issue.status !== 'resolved';
  const fail = (error: unknown): void => toast.error(errorText(error));

  return (
    <li
      className={`rounded-lg p-3 ring-1 ring-inset ${issue.escalated ? 'bg-rose-50 ring-rose-300' : 'bg-white ring-stone-200'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            Room {issue.roomNumber} · {words(issue.category)}
          </p>
          <p className="text-xs text-slate-500">Reported {timeLabel(issue.createdAt)}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={issue.status} />
          <Badge tone={PRIORITY_TONE[issue.priority]}>{issue.priority}</Badge>
        </div>
      </div>
      <p className="mt-2 text-sm text-slate-700">{issue.description}</p>
      {issue.takesRoomOutOfService && open && (
        <p className="mt-1 text-xs font-medium text-rose-800">
          Room is out of service until this is resolved
        </p>
      )}
      {issue.assignedTo && (
        <p className="mt-1 text-xs text-slate-500">Assigned to {issue.assignedTo.name}</p>
      )}
      {issue.escalated && (
        <p className="mt-2 text-sm font-medium text-rose-800">
          Escalated: {issue.escalationReason}
        </p>
      )}
      {issue.resolutionNote && (
        <p className="mt-2 text-sm text-emerald-800">Done: {issue.resolutionNote}</p>
      )}

      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {technician && issue.status === 'new' && (
            <Button
              small
              disabled={assign.isPending}
              onClick={() => assign.mutate({ staffId: staff.id }, { onError: fail })}
            >
              Take it
            </Button>
          )}
          {manager && technicians.length > 0 && (
            <select
              aria-label={`Assign issue for room ${issue.roomNumber}`}
              className="rounded-md border-0 bg-white py-1 pl-2 pr-7 text-sm ring-1 ring-inset ring-slate-300"
              value=""
              onChange={(event) =>
                event.target.value &&
                assign.mutate({ staffId: event.target.value }, { onError: fail })
              }
            >
              <option value="">{issue.assignedTo ? 'Reassign to…' : 'Assign to…'}</option>
              {technicians.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          )}
          {issue.status === 'assigned' && (mine || manager) && (
            <Button
              small
              disabled={start.isPending}
              onClick={() => start.mutate(undefined, { onError: fail })}
            >
              Start work
            </Button>
          )}
          {issue.status === 'in_progress' && (mine || manager) && (
            <Button small onClick={() => setDialog('resolve')}>
              Resolve
            </Button>
          )}
          {!issue.escalated && (
            <Button variant="quiet" small onClick={() => setDialog('escalate')}>
              Escalate
            </Button>
          )}
          {issue.escalated && (staff.role === 'front_desk' || manager) && (
            <Button
              variant="quiet"
              small
              onClick={() => acknowledge.mutate(undefined, { onError: fail })}
            >
              Clear escalation
            </Button>
          )}
        </div>
      )}

      {dialog === 'resolve' && (
        <TextDialog
          title="Resolve this issue"
          prompt="What was done?"
          confirm="Mark resolved"
          busy={resolve.isPending}
          error={resolve.error}
          onClose={() => setDialog(null)}
          onSubmit={(resolutionNote) =>
            resolve.mutate({ resolutionNote }, { onSuccess: () => setDialog(null) })
          }
        />
      )}
      {dialog === 'escalate' && (
        <TextDialog
          title="Escalate to the front desk and managers"
          prompt="Why does this need attention?"
          confirm="Escalate"
          busy={escalate.isPending}
          error={escalate.error}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => escalate.mutate({ reason }, { onSuccess: () => setDialog(null) })}
        />
      )}
    </li>
  );
}

function Column({
  title,
  items,
  technicians,
  empty,
}: {
  title: string;
  items: MaintenanceIssueDto[];
  technicians: StaffDto[];
  empty: string;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
        {title} <Badge>{items.length}</Badge>
      </h2>
      {items.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="space-y-2">
          {items.map((issue) => (
            <IssueCard key={issue.id} issue={issue} technicians={technicians} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function MaintenancePage() {
  const { staff } = useStaff();
  const [reporting, setReporting] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);

  const open = useList<MaintenanceIssueDto>('/maintenance', {
    open: true,
    limit: 100,
    ...(mineOnly ? { mine: true } : {}),
  });
  const resolved = useList<MaintenanceIssueDto>('/maintenance', { status: 'resolved', limit: 10 });
  const summary = useGet<QueueSummaryDto>('/maintenance/summary');
  const rooms = useList<RoomDto>('/rooms', { limit: 100 });
  const people = useGet<StaffDto[]>(
    '/staff',
    { role: 'maintenance', active: true, limit: 100 },
    { enabled: isManager(staff.role) },
  );

  useRefetchOnEvents(['maintenance.changed'], [['/maintenance'], ['/maintenance/summary']]);

  const technicians = people.data?.data ?? [];
  const fresh = open.items.filter((issue) => issue.status === 'new');
  const assigned = open.items.filter((issue) => issue.status === 'assigned');
  const working = open.items.filter((issue) => issue.status === 'in_progress');

  return (
    <div>
      <PageHeader
        title="Maintenance"
        subtitle="Reported problems, updated live"
        actions={
          <>
            {staff.role === 'maintenance' && (
              <Button
                variant="secondary"
                onClick={() => setMineOnly((value) => !value)}
                aria-pressed={mineOnly}
              >
                {mineOnly ? 'Showing my issues' : 'Show only my issues'}
              </Button>
            )}
            <Button onClick={() => setReporting(true)}>Report issue</Button>
          </>
        }
      />
      {summary.data && (
        <p className="mb-4 text-sm text-slate-600">
          {summary.data.data.urgent} urgent open · {summary.data.data.escalated} escalated
        </p>
      )}
      <Async query={open}>
        <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
          <Column title="New" items={fresh} technicians={technicians} empty="Nothing new." />
          <Column
            title="Assigned"
            items={assigned}
            technicians={technicians}
            empty="Nothing assigned."
          />
          <Column
            title="In progress"
            items={working}
            technicians={technicians}
            empty="Nothing in progress."
          />
          <Column
            title="Resolved (latest)"
            items={resolved.items}
            technicians={technicians}
            empty="Nothing resolved yet."
          />
        </div>
      </Async>
      {reporting && (
        <MaintenanceIssueDialog rooms={rooms.items} onClose={() => setReporting(false)} />
      )}
    </div>
  );
}
