import { ROOM_STATUSES } from '@hospitality/constants';
import type { OverviewDto } from '@hospitality/shared-types';
import type { ReactNode } from 'react';
import { Async, Card, PageHeader, dateLabel, words } from '../../components/ui';
import { useGet } from '../../hooks/queries';
import { useRefetchOnEvents } from '../../realtime/RealtimeProvider';
import { EscalationList } from './EscalationList';
import { QueuePanel } from './QueuePanel';
import { rateLabel } from './format';

const LIVE_EVENTS = [
  'housekeeping.changed',
  'maintenance.changed',
  'food_order.changed',
  'facility_booking.changed',
  'booking.changed',
  'room.status_changed',
] as const;

function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-2xl font-semibold text-slate-900">{value}</dd>
    </div>
  );
}

function statusLabel(status: string): string {
  const text = words(status);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sortedStatuses(byStatus: Record<string, number>): [string, number][] {
  const rank = (status: string): number => {
    const index = (ROOM_STATUSES as readonly string[]).indexOf(status);
    return index === -1 ? ROOM_STATUSES.length : index;
  };
  return Object.entries(byStatus).sort(([a], [b]) => rank(a) - rank(b));
}

function Tiles({ data }: { data: OverviewDto }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card title="Occupancy">
        <p className="text-3xl font-semibold text-slate-900">{rateLabel(data.occupancy.rateBp)}</p>
        <p className="mt-1 text-xs text-slate-500">
          {data.occupancy.occupied} of {data.occupancy.sellable} sellable rooms
        </p>
      </Card>
      <Card title="In house">
        <p className="text-3xl font-semibold text-slate-900">{data.inHouse}</p>
        <p className="mt-1 text-xs text-slate-500">Checked-in bookings</p>
      </Card>
      <Card title="Arrivals">
        <dl className="grid grid-cols-2 gap-3">
          <Figure label="Expected" value={data.arrivals.expected} />
          <Figure label="Checked in" value={data.arrivals.checkedIn} />
        </dl>
      </Card>
      <Card title="Departures">
        <dl className="grid grid-cols-2 gap-3">
          <Figure label="Expected" value={data.departures.expected} />
          <Figure label="Checked out" value={data.departures.checkedOut} />
        </dl>
      </Card>
      <Card title="Rooms by status" className="sm:col-span-2 xl:col-span-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {sortedStatuses(data.rooms.byStatus).map(([status, count]) => (
            <Figure key={status} label={statusLabel(status)} value={count} />
          ))}
        </dl>
        <p className="mt-2 text-xs text-slate-500">{data.rooms.active} active rooms</p>
      </Card>
    </div>
  );
}

function Queues({ data }: { data: OverviewDto }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <QueuePanel title="Housekeeping queue" queue={data.queues.housekeeping} />
      <QueuePanel title="Maintenance queue" queue={data.queues.maintenance} />
      <QueuePanel title="Kitchen queue" queue={data.queues.kitchen} />
      <QueuePanel title="Spa and recreation queue" queue={data.queues.spa} />
    </div>
  );
}

export function DashboardPage() {
  const overview = useGet<OverviewDto>('/manager/overview');
  useRefetchOnEvents(LIVE_EVENTS, [['/manager/overview']]);
  const data = overview.data?.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle={data ? `${dateLabel(data.date)}, updated live` : 'Today, updated live'}
      />
      <Async query={overview}>
        {data && (
          <>
            <Tiles data={data} />
            <Queues data={data} />
            <EscalationList items={data.escalations} />
          </>
        )}
      </Async>
    </div>
  );
}
