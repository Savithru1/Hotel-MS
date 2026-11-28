import type { OccupancyDto, ResponseTimesDto, RevenueDto } from '@hospitality/shared-types';
import { statsRangeQuerySchema } from '@hospitality/validation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Async, Button, Card, PageHeader, TextField } from '../../components/ui';
import { useGet } from '../../hooks/queries';
import { OccupancyTable } from './OccupancyTable';
import { ResponseTimes } from './ResponseTimes';
import { CashFlowTable, RevenueTable } from './RevenueTable';
import { todayLocal } from './format';

interface Range {
  from: string;
  to: string;
}

type RangeErrors = Partial<Record<'from' | 'to', string>>;

/** Checks the range with the same rules the server uses (from <= to, at most 92 days). */
function checkRange(range: Range): RangeErrors {
  if (!range.from || !range.to) return { to: 'Enter both dates.' };
  const parsed = statsRangeQuerySchema.safeParse(range);
  if (parsed.success) return {};
  const errors: RangeErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] === 'from' ? 'from' : 'to';
    errors[field] ??= issue.message;
  }
  return errors;
}

function RangeForm({ range, onApply }: { range: Range; onApply: (next: Range) => void }) {
  const [draft, setDraft] = useState<Range>(range);
  const [errors, setErrors] = useState<RangeErrors>({});

  function submit(event: FormEvent): void {
    event.preventDefault();
    const found = checkRange(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) onApply(draft);
  }

  return (
    <form onSubmit={submit} className="mb-6 flex flex-wrap items-start gap-3">
      <TextField
        label="From"
        type="date"
        value={draft.from}
        onChange={(event) => setDraft({ ...draft, from: event.target.value })}
        error={errors.from}
      />
      <TextField
        label="To"
        type="date"
        value={draft.to}
        onChange={(event) => setDraft({ ...draft, to: event.target.value })}
        error={errors.to}
      />
      <Button type="submit" className="mt-6">
        Show
      </Button>
    </form>
  );
}

interface SectionProps<T> {
  title: string;
  path: string;
  range: Range;
  children: (data: T) => ReactNode;
}

function Section<T>({ title, path, range, children }: SectionProps<T>) {
  const query = useGet<T>(path, { from: range.from, to: range.to });
  return (
    <Card title={title}>
      <Async query={query}>{query.data && children(query.data.data)}</Async>
    </Card>
  );
}

export function StatsPage() {
  const [range, setRange] = useState<Range>(() => ({ from: todayLocal(), to: todayLocal() }));
  return (
    <div className="space-y-6">
      <PageHeader
        title="Statistics"
        subtitle="Occupancy, revenue and how quickly work is done, for a date range of at most 92 days"
      />
      <RangeForm range={range} onApply={setRange} />
      <Section<OccupancyDto> title="Occupancy" path="/manager/stats/occupancy" range={range}>
        {(data) => <OccupancyTable data={data} />}
      </Section>
      <Section<RevenueDto> title="Revenue" path="/manager/stats/revenue" range={range}>
        {(data) => (
          <div className="space-y-6">
            <RevenueTable data={data} />
            <CashFlowTable data={data} />
          </div>
        )}
      </Section>
      <Section<ResponseTimesDto>
        title="Response times"
        path="/manager/stats/response-times"
        range={range}
      >
        {(data) => <ResponseTimes data={data} />}
      </Section>
    </div>
  );
}
