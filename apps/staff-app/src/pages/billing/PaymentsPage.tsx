import type { PaymentDto, PaymentsSummaryDto } from '@hospitality/shared-types';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  Async,
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  TextField,
  money,
} from '../../components/ui';
import { useGet, useList } from '../../hooks/queries';
import { useRefetchOnEvents } from '../../realtime/RealtimeProvider';
import { METHOD_LABELS } from './billing-form';

/** Today's date in the browser's timezone, as `YYYY-MM-DD`. */
const todayLocal = (): string => new Date().toLocaleDateString('en-CA');

function Summary({ summary }: { summary: PaymentsSummaryDto }) {
  const methods = Object.entries(summary.netByMethod).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-3">
      <Card title="Collected">
        <p className="text-2xl font-semibold text-slate-900">{money(summary.collectedPaise)}</p>
      </Card>
      <Card title="Refunded">
        <p className="text-2xl font-semibold text-slate-900">{money(summary.refundedPaise)}</p>
      </Card>
      <Card title="Net for the day">
        <p className="text-2xl font-semibold text-slate-900">{money(summary.netPaise)}</p>
        {methods.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-sm text-slate-600">
            {methods.map(([method, paise]) => (
              <li key={method} className="flex justify-between gap-4">
                <span>{METHOD_LABELS[method as keyof typeof METHOD_LABELS] ?? method}</span>
                <span>{money(paise)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Every payment and refund taken at the desk for a day, with the day's totals by method. */
export function PaymentsPage() {
  const [day, setDay] = useState(todayLocal);
  const summary = useGet<PaymentsSummaryDto>('/payments/summary', { date: day });
  const payments = useList<PaymentDto>('/payments', { date: day, limit: 100 });
  useRefetchOnEvents(['booking.changed'], [['/payments'], ['/payments/summary']]);

  return (
    <div>
      <PageHeader
        title="Payments"
        subtitle="Money taken and refunded at the desk"
        actions={
          <TextField
            label="Day"
            type="date"
            value={day}
            onChange={(event) => event.target.value && setDay(event.target.value)}
          />
        }
      />
      {summary.isError ? (
        <div className="mb-4">
          <ErrorNotice error={summary.error} onRetry={() => void summary.refetch()} />
        </div>
      ) : (
        summary.data && <Summary summary={summary.data.data} />
      )}

      <Async query={payments}>
        {payments.items.length === 0 ? (
          <EmptyState>No payments on this day.</EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-stone-200">
            <table className="min-w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2">Time</th>
                  <th className="px-4 py-2">Booking ID</th>
                  <th className="px-4 py-2">Guest</th>
                  <th className="px-4 py-2">Method</th>
                  <th className="px-4 py-2">Reference</th>
                  <th className="px-4 py-2">Taken by</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {payments.items.map((payment) => (
                  <tr key={payment.id}>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {new Date(payment.createdAt).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-4 py-2 font-mono">
                      <Link
                        to={`/bills/${payment.bookingId}`}
                        className="text-teal-800 underline-offset-2 hover:underline"
                      >
                        {payment.bookingCode}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{payment.guestName}</td>
                    <td className="px-4 py-2">
                      {METHOD_LABELS[payment.method]}{' '}
                      {payment.kind === 'refund' && <Badge tone="bad">Refund</Badge>}
                    </td>
                    <td className="px-4 py-2">{payment.reference || payment.reason || '—'}</td>
                    <td className="px-4 py-2">{payment.recordedBy}</td>
                    <td
                      className={`px-4 py-2 text-right ${payment.kind === 'refund' ? 'text-rose-700' : ''}`}
                    >
                      {payment.kind === 'refund' ? '− ' : ''}
                      {money(payment.amountPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </div>
  );
}
