import type { QueueOverviewDto } from '@hospitality/shared-types';
import { Card } from '../../components/ui';

const STATS: readonly { key: keyof QueueOverviewDto; label: string; alarm: boolean }[] = [
  { key: 'pending', label: 'Pending', alarm: false },
  { key: 'completedToday', label: 'Completed today', alarm: false },
  { key: 'escalated', label: 'Escalated', alarm: true },
  { key: 'urgent', label: 'Urgent', alarm: true },
];

/** One department's work queue as four numbers. Escalated and urgent turn red when above zero. */
export function QueuePanel({ title, queue }: { title: string; queue: QueueOverviewDto }) {
  return (
    <Card title={title}>
      <dl className="grid grid-cols-2 gap-3">
        {STATS.map(({ key, label, alarm }) => (
          <div key={key}>
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd
              className={`text-2xl font-semibold ${
                alarm && queue[key] > 0 ? 'text-rose-700' : 'text-slate-900'
              }`}
            >
              {queue[key]}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
