import type { AuditEntryDto } from '@hospitality/shared-types';
import { auditLogQuerySchema } from '@hospitality/validation';
import { useState, type FormEvent } from 'react';
import { Async, Button, EmptyState, PageHeader, TextField } from '../../components/ui';
import { useList } from '../../hooks/queries';
import {
  AUDIT_PAGE_SIZE,
  EMPTY_FILTERS,
  buildAuditQuery,
  summaryText,
  type AuditFilters,
} from './audit-query';
import { dateTimeLabel } from './format';
import { BODY, HEAD, TABLE, TD, TH, WRAP } from './table-styles';

const DETAIL_CHARS = 160;

type FilterErrors = Partial<Record<'from' | 'to', string>>;

function actorName(actor: AuditEntryDto['actor']): string {
  if (actor.kind === 'system') return 'System';
  if (actor.kind === 'guest') return 'Guest';
  return actor.name ?? 'Unknown staff member';
}

/** Checks the date range with the server's own rules before asking. */
function rangeErrors(filters: AuditFilters): FilterErrors {
  const parsed = auditLogQuerySchema.safeParse(buildAuditQuery(filters, 1));
  if (parsed.success) return {};
  const errors: FilterErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'from' || field === 'to') errors[field] ??= issue.message;
  }
  return errors;
}

function FilterForm({ onApply }: { onApply: (filters: AuditFilters) => void }) {
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [errors, setErrors] = useState<FilterErrors>({});
  const bind = (key: keyof AuditFilters) => ({
    value: draft[key],
    onChange: (event: { target: { value: string } }) =>
      setDraft({ ...draft, [key]: event.target.value }),
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    const found = rangeErrors(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) onApply(draft);
  }

  function clear(): void {
    setDraft(EMPTY_FILTERS);
    setErrors({});
    onApply(EMPTY_FILTERS);
  }

  return (
    <form onSubmit={submit} className="mb-6 grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <TextField label="From" type="date" error={errors.from} {...bind('from')} />
      <TextField label="To" type="date" error={errors.to} {...bind('to')} />
      <TextField label="Action" placeholder="for example staff.update" {...bind('action')} />
      <TextField
        label="Person"
        hint="A staff id, or system for background jobs"
        {...bind('actor')}
      />
      <TextField label="Record type" placeholder="for example staff" {...bind('targetType')} />
      <TextField label="Record id" {...bind('targetId')} />
      <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit">Apply filters</Button>
        <Button variant="secondary" onClick={clear}>
          Clear filters
        </Button>
      </div>
    </form>
  );
}

function EntryRow({ entry }: { entry: AuditEntryDto }) {
  const who = actorName(entry.actor);
  return (
    <tr aria-label={`${who} ${entry.action}`} className="align-top">
      <td className={`${TD} whitespace-nowrap`}>{dateTimeLabel(entry.at)}</td>
      <td className={TD}>
        <p className="font-medium text-slate-900">{who}</p>
        {entry.actor.role && <p className="text-xs text-slate-500">{entry.actor.role}</p>}
      </td>
      <td className={`${TD} font-mono text-xs`}>{entry.action}</td>
      <td className={TD}>
        <p>{entry.target.type}</p>
        <p className="font-mono text-xs text-slate-500">{entry.target.id}</p>
      </td>
      <td className={`${TD} break-words text-xs text-slate-600`}>
        {summaryText(entry.summary, DETAIL_CHARS)}
      </td>
    </tr>
  );
}

function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  return (
    <nav aria-label="Pages" className="mt-4 flex items-center justify-between gap-3 text-sm">
      <p className="text-slate-600">{total} entries</p>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          small
          disabled={page <= 1}
          aria-label="Previous page"
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <span>
          Page {page} of {pages}
        </span>
        <Button
          variant="secondary"
          small
          disabled={page >= pages}
          aria-label="Next page"
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

/** Who did what, newest first. Read-only. Secrets are removed by the server before they get here. */
export function AuditLogPage() {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const log = useList<AuditEntryDto>('/audit-logs', buildAuditQuery(filters, page));

  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle="Sensitive actions at this property. Entries cannot be changed or removed."
      />
      <FilterForm
        onApply={(next) => {
          setFilters(next);
          setPage(1);
        }}
      />
      <Async query={log}>
        {log.items.length === 0 ? (
          <EmptyState>No audit entries match these filters.</EmptyState>
        ) : (
          <div className="rounded-lg bg-white shadow-sm ring-1 ring-stone-200">
            <div className={WRAP}>
              <table className={TABLE} aria-label="Audit log">
                <thead className={HEAD}>
                  <tr>
                    <th className={TH}>When</th>
                    <th className={TH}>Who</th>
                    <th className={TH}>Action</th>
                    <th className={TH}>Record</th>
                    <th className={TH}>Details</th>
                  </tr>
                </thead>
                <tbody className={BODY}>
                  {log.items.map((entry) => (
                    <EntryRow key={entry.id} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {log.meta && <Pager page={page} total={log.meta.total} onPage={setPage} />}
      </Async>
    </div>
  );
}
