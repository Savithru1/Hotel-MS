import type { BillDto, BillLineDto, BookingDto } from '@hospitality/shared-types';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useStaff } from '../../auth/AuthContext';
import { isManager } from '../../auth/permissions';
import {
  Async,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  StatusBadge,
  dateLabel,
  errorText,
  money,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useGet, useSend } from '../../hooks/queries';
import { useRefetchOnEvents } from '../../realtime/RealtimeProvider';
import {
  ChargeDialog,
  CheckOutDialog,
  CreditNoteDialog,
  PaymentDialog,
  RefundDialog,
} from './BillingDialogs';
import { METHOD_LABELS } from './billing-form';

type Dialogs = 'charge' | 'payment' | 'refund' | 'checkout' | null;

function TotalRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className={`flex justify-between gap-6 py-0.5 ${strong ? 'font-semibold' : ''}`}>
      <dt className="text-slate-600">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** What is printed above an issued invoice. Hidden on screen, shown on paper. */
function InvoiceHeader({ bill }: { bill: BillDto }) {
  const invoice = bill.invoice;
  if (!invoice) return null;
  return (
    <section aria-label="Tax invoice" className="mb-4 hidden print:block">
      <h1 className="text-xl font-bold">Tax invoice</h1>
      <p className="mt-1 font-semibold">{invoice.supplier.legalName}</p>
      <p className="text-sm">{invoice.supplier.address}</p>
      {invoice.supplier.gstin && <p className="text-sm">GSTIN: {invoice.supplier.gstin}</p>}
      <dl className="mt-3 grid grid-cols-2 gap-x-6 text-sm">
        <dt>Invoice number</dt>
        <dd className="font-mono">{invoice.number}</dd>
        <dt>Date</dt>
        <dd>{new Date(invoice.issuedAt).toLocaleDateString('en-IN')}</dd>
        <dt>Billed to</dt>
        <dd>{bill.guest.name}</dd>
        {bill.guest.gstin && (
          <>
            <dt>Guest GSTIN</dt>
            <dd className="font-mono">{bill.guest.gstin}</dd>
          </>
        )}
        <dt>Place of supply</dt>
        <dd>{invoice.placeOfSupplyState}</dd>
      </dl>
    </section>
  );
}

function LinesTable({
  bill,
  canCredit,
  onRemove,
  onCredit,
}: {
  bill: BillDto;
  canCredit: boolean;
  onRemove: (line: BillLineDto) => void;
  onCredit: (line: BillLineDto) => void;
}) {
  if (bill.lines.length === 0) return <EmptyState>Nothing has been charged yet.</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="py-2 pr-3">Description</th>
            <th className="py-2 pr-3">Date</th>
            <th className="py-2 pr-3 text-right">Before tax</th>
            <th className="py-2 pr-3 text-right">GST</th>
            <th className="py-2 pr-3 text-right">Total</th>
            <th className="py-2 print:hidden">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {bill.lines.map((line) => (
            <tr key={line.id} className={line.creditNoteNumber ? 'text-slate-400' : ''}>
              <td className="py-2 pr-3">
                <p className={line.creditNoteNumber ? 'line-through' : ''}>{line.description}</p>
                <p className="text-xs text-slate-500">
                  SAC {line.sacCode}
                  {line.reason ? ` · ${line.reason}` : ''}
                  {line.approvedBy ? ` · approved by ${line.approvedBy}` : ''}
                </p>
                {line.creditNoteNumber && (
                  <p className="text-xs text-rose-700">Reversed by {line.creditNoteNumber}</p>
                )}
              </td>
              <td className="py-2 pr-3 whitespace-nowrap">{dateLabel(line.serviceDate)}</td>
              <td className="py-2 pr-3 text-right">{money(line.taxablePaise)}</td>
              <td className="py-2 pr-3 text-right whitespace-nowrap">
                {money(line.taxPaise)}{' '}
                <span className="text-xs text-slate-500">({line.ratePercent}%)</span>
              </td>
              <td className="py-2 pr-3 text-right font-medium">{money(line.totalPaise)}</td>
              <td className="py-2 text-right print:hidden">
                {bill.status === 'open' && line.manual && (
                  <Button variant="quiet" small onClick={() => onRemove(line)}>
                    Remove
                  </Button>
                )}
                {bill.status === 'finalized' &&
                  canCredit &&
                  line.kind !== 'discount' &&
                  !line.creditNoteNumber && (
                    <Button variant="quiet" small onClick={() => onCredit(line)}>
                      Credit note
                    </Button>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TotalsCard({ bill }: { bill: BillDto }) {
  const totals = bill.totals;
  const split = totals.igstPaise > 0;
  return (
    <Card title="Totals">
      <dl className="text-sm">
        <TotalRow label="Before tax" value={money(totals.taxablePaise)} />
        {split ? (
          <TotalRow label="IGST" value={money(totals.igstPaise)} />
        ) : (
          <>
            <TotalRow label="CGST" value={money(totals.cgstPaise)} />
            <TotalRow label="SGST" value={money(totals.sgstPaise)} />
          </>
        )}
        {totals.roundOffPaise !== 0 && (
          <TotalRow label="Round off" value={money(totals.roundOffPaise)} />
        )}
        <TotalRow label="Total" value={money(totals.totalPaise)} strong />
        {bill.creditNotePaise > 0 && (
          <TotalRow label="Credit notes" value={`− ${money(bill.creditNotePaise)}`} />
        )}
        <TotalRow label="Paid" value={money(bill.paidPaise)} />
        {bill.refundedPaise > 0 && <TotalRow label="Refunded" value={money(bill.refundedPaise)} />}
        <div className="mt-2 border-t border-stone-200 pt-2">
          <TotalRow
            label={bill.balancePaise < 0 ? 'Owed to guest' : 'Balance due'}
            value={money(Math.abs(bill.balancePaise))}
            strong
          />
        </div>
      </dl>
    </Card>
  );
}

function PaymentsCard({ bill }: { bill: BillDto }) {
  return (
    <Card title="Payments">
      {bill.payments.length === 0 ? (
        <EmptyState>No payments yet.</EmptyState>
      ) : (
        <ul className="divide-y divide-stone-100 text-sm">
          {bill.payments.map((payment) => (
            <li key={payment.id} className="flex items-start justify-between gap-3 py-2">
              <div>
                <p className="font-medium">
                  {payment.kind === 'refund' ? 'Refund' : 'Payment'} ·{' '}
                  {METHOD_LABELS[payment.method]}
                </p>
                <p className="text-xs text-slate-500">
                  {new Date(payment.createdAt).toLocaleString('en-IN')} · {payment.recordedBy}
                  {payment.reference ? ` · ${payment.reference}` : ''}
                  {payment.reason ? ` · ${payment.reason}` : ''}
                </p>
              </div>
              <span className={payment.kind === 'refund' ? 'text-rose-700' : ''}>
                {payment.kind === 'refund' ? '− ' : ''}
                {money(payment.amountPaise)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CreditNotesCard({ bill }: { bill: BillDto }) {
  if (bill.creditNotes.length === 0) return null;
  return (
    <Card title="Credit notes" className="mt-4">
      <ul className="divide-y divide-stone-100 text-sm">
        {bill.creditNotes.map((note) => (
          <li key={note.id} className="flex justify-between gap-3 py-2">
            <div>
              <p className="font-mono">{note.number}</p>
              <p className="text-xs text-slate-500">
                {note.description} · {note.reason} · {note.issuedBy}
              </p>
            </div>
            <span>{money(note.totalPaise)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** One guest's bill: charges and tax, payments, and the steps from there to check-out. */
export function BillPage() {
  const { bookingId = '' } = useParams();
  const { staff } = useStaff();
  const toast = useToast();
  const manager = isManager(staff.role);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [crediting, setCrediting] = useState<BillLineDto | null>(null);

  const bill = useGet<BillDto>(`/bills/by-booking/${bookingId}`);
  const booking = useGet<BookingDto>(`/bookings/${bookingId}`);
  useRefetchOnEvents(
    ['food_order.changed', 'facility_booking.changed', 'booking.changed'],
    [[`/bills/by-booking/${bookingId}`], [`/bookings/${bookingId}`]],
  );

  const current = bill.data?.data;
  const removeLine = useSend<BillDto, string>(
    'delete',
    (lineId) => `/bills/${current?.id}/lines/${lineId}`,
    ['/bills'],
  );
  const finalize = useSend<BillDto, void>('post', `/bills/${current?.id}/finalize`, [
    '/bills',
    '/payments',
  ]);
  const inHouse = booking.data?.data.status === 'checked_in';
  const fail = (error: unknown): void => toast.error(errorText(error));

  return (
    <div>
      <div className="print:hidden">
        <PageHeader
          title={current ? `Bill for ${current.guest.name}` : 'Bill'}
          {...(current
            ? {
                subtitle: `Room ${current.roomNumber} · ${dateLabel(current.checkInDate)} → ${dateLabel(
                  current.checkOutDate,
                )} (${current.nights} nights) · Booking ${current.bookingCode}`,
              }
            : {})}
          actions={
            <Link
              to="/bookings"
              className="rounded-md px-3 py-2 text-sm text-teal-900 hover:bg-teal-50"
            >
              Back to bookings
            </Link>
          }
        />
      </div>

      <Async query={bill}>
        {current && (
          <>
            <InvoiceHeader bill={current} />
            <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
              <Badge tone={current.status === 'open' ? 'warn' : 'good'}>
                {current.status === 'open' ? 'Open' : 'Invoice issued'}
              </Badge>
              {current.invoice && (
                <span className="font-mono text-sm">{current.invoice.number}</span>
              )}
              {booking.data && <StatusBadge status={booking.data.data.status} />}
              {current.guest.gstin && (
                <span className="text-sm text-slate-600">GSTIN {current.guest.gstin}</span>
              )}
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card title="Charges" className="lg:col-span-2">
                <LinesTable
                  bill={current}
                  canCredit={manager}
                  onRemove={(line) => removeLine.mutate(line.id, { onError: fail })}
                  onCredit={setCrediting}
                />
              </Card>
              <div className="space-y-4">
                <TotalsCard bill={current} />
                <PaymentsCard bill={current} />
              </div>
            </div>
            <CreditNotesCard bill={current} />

            <div className="mt-4 flex flex-wrap justify-end gap-2 print:hidden">
              {current.status === 'open' && (
                <Button variant="secondary" onClick={() => setDialog('charge')}>
                  Add charge or discount
                </Button>
              )}
              {current.balancePaise > 0 && (
                <Button onClick={() => setDialog('payment')}>Record payment</Button>
              )}
              {manager && current.paidPaise - current.refundedPaise > 0 && (
                <Button variant="secondary" onClick={() => setDialog('refund')}>
                  Refund
                </Button>
              )}
              {current.status === 'open' && (
                <Button
                  variant="secondary"
                  disabled={finalize.isPending}
                  onClick={() => finalize.mutate(undefined, { onError: fail })}
                >
                  Issue invoice
                </Button>
              )}
              {current.invoice && (
                <Button variant="secondary" onClick={() => window.print()}>
                  Print invoice
                </Button>
              )}
              {inHouse && <Button onClick={() => setDialog('checkout')}>Check out</Button>}
            </div>
          </>
        )}
      </Async>

      {current && dialog === 'charge' && (
        <ChargeDialog bill={current} canApprove={manager} onClose={() => setDialog(null)} />
      )}
      {current && dialog === 'payment' && (
        <PaymentDialog bill={current} onClose={() => setDialog(null)} />
      )}
      {current && dialog === 'refund' && (
        <RefundDialog bill={current} onClose={() => setDialog(null)} />
      )}
      {current && dialog === 'checkout' && (
        <CheckOutDialog bill={current} canOverride={manager} onClose={() => setDialog(null)} />
      )}
      {current && crediting && (
        <CreditNoteDialog bill={current} line={crediting} onClose={() => setCrediting(null)} />
      )}
    </div>
  );
}
