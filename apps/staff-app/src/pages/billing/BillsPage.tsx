import { BILL_STATUSES } from '@hospitality/constants';
import type { BillSummaryDto } from '@hospitality/shared-types';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  Async,
  Badge,
  Button,
  EmptyState,
  PageHeader,
  SelectField,
  money,
} from '../../components/ui';
import { useList } from '../../hooks/queries';

const PAGE_SIZE = 20;

/** Every bill, newest first, with what is still owed. Open one to work on it. */
export function BillsPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const bills = useList<BillSummaryDto>('/bills', {
    page,
    limit: PAGE_SIZE,
    ...(status ? { status } : {}),
  });
  const total = bills.meta?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Bills"
        subtitle="Open bills of guests in the hotel and issued invoices"
        actions={
          <SelectField
            label="Status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {BILL_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value === 'open' ? 'Open' : 'Invoice issued'}
              </option>
            ))}
          </SelectField>
        }
      />
      <Async query={bills}>
        {bills.items.length === 0 ? (
          <EmptyState>
            No bills yet. A bill opens when a guest checks in and you view it.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-stone-200">
            <table className="min-w-full text-sm">
              <thead className="bg-stone-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2">Booking ID</th>
                  <th className="px-4 py-2">Guest</th>
                  <th className="px-4 py-2">Room</th>
                  <th className="px-4 py-2">Invoice</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {bills.items.map((bill) => (
                  <tr key={bill.id}>
                    <td className="px-4 py-2 font-mono">
                      <Link
                        to={`/bills/${bill.bookingId}`}
                        className="text-teal-800 underline-offset-2 hover:underline"
                      >
                        {bill.bookingCode}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{bill.guestName}</td>
                    <td className="px-4 py-2">{bill.roomNumber}</td>
                    <td className="px-4 py-2 font-mono text-xs">{bill.invoiceNumber ?? '—'}</td>
                    <td className="px-4 py-2 text-right">{money(bill.totalPaise)}</td>
                    <td
                      className={`px-4 py-2 text-right ${bill.balancePaise !== 0 ? 'font-semibold text-amber-800' : ''}`}
                    >
                      {money(bill.balancePaise)}
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={bill.status === 'open' ? 'warn' : 'good'}>
                        {bill.status === 'open' ? 'Open' : 'Issued'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
          <span>
            <Badge>{total}</Badge> bills
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              small
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
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
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </Async>
    </div>
  );
}
