import type { OccupancyDto } from '@hospitality/shared-types';
import { dateLabel } from '../../components/ui';
import { rateLabel } from './format';
import { BODY, HEAD, TABLE, TD, TD_NUM, TH, TH_NUM, WRAP } from './table-styles';

const BASIS_LABEL = { actual: 'Actual', on_the_books: 'On the books' } as const;

/** A plain bar for a rate in basis points. Hidden from screen readers: the number is beside it. */
function RateBar({ rateBp }: { rateBp: number }) {
  const width = Math.min(100, Math.max(0, rateBp / 100));
  return (
    <span aria-hidden="true" className="block h-2 w-24 rounded-full bg-stone-100">
      <span className="block h-2 rounded-full bg-teal-700" style={{ width: `${width}%` }} />
    </span>
  );
}

export function OccupancyTable({ data }: { data: OccupancyDto }) {
  return (
    <>
      <div className={WRAP}>
        <table className={TABLE} aria-label="Occupancy by day">
          <thead className={HEAD}>
            <tr>
              <th className={TH}>Date</th>
              <th className={TH_NUM}>Occupied</th>
              <th className={TH_NUM}>Sellable</th>
              <th className={TH}>Occupancy</th>
              <th className={TH}>Basis</th>
            </tr>
          </thead>
          <tbody className={BODY}>
            {data.days.map((day) => (
              <tr key={day.date} aria-label={day.date}>
                <td className={TD}>{dateLabel(day.date)}</td>
                <td className={TD_NUM}>{day.occupied}</td>
                <td className={TD_NUM}>{day.sellable}</td>
                <td className={TD}>
                  <span className="flex items-center gap-2">
                    <span className="w-14 tabular-nums">{rateLabel(day.rateBp)}</span>
                    {day.rateBp !== null && <RateBar rateBp={day.rateBp} />}
                  </span>
                </td>
                <td className={TD}>{BASIS_LABEL[day.basis]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Sellable is today&apos;s count of active rooms. The system does not keep past room changes,
        so earlier days use the same count. Days after today show bookings on the books.
      </p>
    </>
  );
}
