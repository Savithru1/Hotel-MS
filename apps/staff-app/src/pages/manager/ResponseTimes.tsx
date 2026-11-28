import type { ResponseTimeDto, ResponseTimesDto } from '@hospitality/shared-types';
import { durationLabel } from './format';
import { BODY, HEAD, TABLE, TD, TD_NUM, TH, TH_NUM, WRAP } from './table-styles';

const ROWS: readonly { key: 'housekeeping' | 'maintenance' | 'kitchen'; label: string }[] = [
  { key: 'housekeeping', label: 'Housekeeping' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'kitchen', label: 'Kitchen' },
];

function Cells({ item }: { item: ResponseTimeDto }) {
  return (
    <>
      <td className={TD_NUM}>{item.n}</td>
      <td className={TD_NUM}>{durationLabel(item.firstActionSeconds)}</td>
      <td className={TD_NUM}>{durationLabel(item.completionSeconds)}</td>
    </>
  );
}

/** Average time to first action and to completion. No data is shown as "No data", never 0. */
export function ResponseTimes({ data }: { data: ResponseTimesDto }) {
  return (
    <>
      <div className={WRAP}>
        <table className={TABLE} aria-label="Response times">
          <thead className={HEAD}>
            <tr>
              <th className={TH}>Department</th>
              <th className={TH_NUM}>Requests</th>
              <th className={TH_NUM}>Average first action</th>
              <th className={TH_NUM}>Average completion</th>
            </tr>
          </thead>
          <tbody className={BODY}>
            {ROWS.map(({ key, label }) => (
              <tr key={key} aria-label={label}>
                <td className={TD}>{label}</td>
                <Cells item={data[key]} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Requests created in the range and not cancelled. Spa and recreation is not measured.
      </p>
    </>
  );
}
