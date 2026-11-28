import { GST_CATEGORIES, type GstCategory } from '@hospitality/constants';
import type { RevenueAmountDto, RevenueDto } from '@hospitality/shared-types';
import { dateLabel, money } from '../../components/ui';
import { dateTimeLabel } from './format';
import { BODY, HEAD, TABLE, TD, TD_NUM, TH, TH_NUM, WRAP } from './table-styles';

const DEPARTMENT_LABEL: Record<GstCategory, string> = {
  room: 'Room',
  food: 'Food',
  spa_recreation: 'Spa and recreation',
  other: 'Other',
};

function AmountCells({ amount }: { amount: RevenueAmountDto }) {
  return (
    <>
      <td className={TD_NUM}>{money(amount.taxablePaise)}</td>
      <td className={TD_NUM}>{money(amount.taxPaise)}</td>
      <td className={TD_NUM}>{money(amount.totalPaise)}</td>
    </>
  );
}

interface GroupProps {
  scope: string;
  title: string;
  departments: Record<GstCategory, RevenueAmountDto>;
  total: RevenueAmountDto;
  totalLabel: string;
}

function Group({ scope, title, departments, total, totalLabel }: GroupProps) {
  return (
    <>
      {GST_CATEGORIES.map((category, index) => (
        <tr key={category} aria-label={`${scope} ${DEPARTMENT_LABEL[category]}`}>
          <td className={TD}>{index === 0 ? title : ''}</td>
          <td className={TD}>{DEPARTMENT_LABEL[category]}</td>
          <AmountCells amount={departments[category]} />
        </tr>
      ))}
      <tr aria-label={`${scope} ${totalLabel}`} className="bg-stone-50 font-semibold">
        <td className={TD} />
        <td className={TD}>{totalLabel}</td>
        <AmountCells amount={total} />
      </tr>
    </>
  );
}

export function RevenueTable({ data }: { data: RevenueDto }) {
  return (
    <>
      <p className="mb-2 text-sm text-slate-600">
        {data.lastSyncedAt
          ? `Posted up to ${dateTimeLabel(data.lastSyncedAt)}`
          : 'Bills have not been synced yet'}
      </p>
      <div className={WRAP}>
        <table className={TABLE} aria-label="Revenue by day and department">
          <thead className={HEAD}>
            <tr>
              <th className={TH}>Date</th>
              <th className={TH}>Department</th>
              <th className={TH_NUM}>Taxable</th>
              <th className={TH_NUM}>GST</th>
              <th className={TH_NUM}>Total</th>
            </tr>
          </thead>
          <tbody className={BODY}>
            {data.days.map((day) => (
              <Group
                key={day.date}
                scope={day.date}
                title={dateLabel(day.date)}
                departments={day.departments}
                total={day.total}
                totalLabel="Day total"
              />
            ))}
            <Group
              scope="Whole range"
              title="Whole range"
              departments={data.totals.departments}
              total={data.totals.total}
              totalLabel="Total"
            />
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Money that came in and went out on each day. Separate from revenue: a refund is not a credit note. */
export function CashFlowTable({ data }: { data: RevenueDto }) {
  return (
    <div className={WRAP}>
      <table className={TABLE} aria-label="Cash received and refunded">
        <thead className={HEAD}>
          <tr>
            <th className={TH}>Date</th>
            <th className={TH_NUM}>Received</th>
            <th className={TH_NUM}>Refunded</th>
          </tr>
        </thead>
        <tbody className={BODY}>
          {data.payments.map((day) => (
            <tr key={day.date} aria-label={day.date}>
              <td className={TD}>{dateLabel(day.date)}</td>
              <td className={TD_NUM}>{money(day.receivedPaise)}</td>
              <td className={TD_NUM}>{money(day.refundedPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
