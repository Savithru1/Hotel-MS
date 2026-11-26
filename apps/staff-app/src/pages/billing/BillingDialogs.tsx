import {
  MANUAL_LINE_CATEGORIES,
  PAYMENT_METHODS,
  type ManualLineCategory,
  type PaymentMethod,
} from '@hospitality/constants';
import type { BillDto, BillLineDto, CheckOutResultDto } from '@hospitality/shared-types';
import { useState, type FormEvent } from 'react';
import {
  Button,
  Dialog,
  ErrorNotice,
  SelectField,
  TextField,
  errorText,
  money,
} from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useSend } from '../../hooks/queries';
import {
  CATEGORY_LABELS,
  METHOD_LABELS,
  buildChargePayload,
  buildPaymentPayload,
  buildRefundPayload,
  emptyChargeForm,
  needsManager,
  paiseToRupees,
  type ChargeForm,
} from './billing-form';

/** Everything a money change can touch: bills, bookings, rooms and the cleaning queue. */
const REFRESH = ['/bills', '/payments', '/bookings', '/rooms', '/housekeeping'];

interface DialogProps {
  bill: BillDto;
  onClose: () => void;
}

function Actions({
  onClose,
  busy,
  submit,
  tone = 'primary',
}: {
  onClose: () => void;
  busy: boolean;
  submit: string;
  tone?: 'primary' | 'danger';
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="secondary" onClick={onClose}>
        Back
      </Button>
      <Button type="submit" variant={tone} disabled={busy}>
        {submit}
      </Button>
    </div>
  );
}

function MethodField({
  value,
  onChange,
}: {
  value: PaymentMethod;
  onChange: (value: PaymentMethod) => void;
}) {
  return (
    <SelectField
      label="Method"
      value={value}
      onChange={(event) => onChange(event.target.value as PaymentMethod)}
    >
      {PAYMENT_METHODS.map((method) => (
        <option key={method} value={method}>
          {METHOD_LABELS[method]}
        </option>
      ))}
    </SelectField>
  );
}

export function ChargeDialog({ bill, onClose, canApprove }: DialogProps & { canApprove: boolean }) {
  const toast = useToast();
  const [form, setForm] = useState<ChargeForm>(emptyChargeForm);
  const [problem, setProblem] = useState<string | null>(null);
  const add = useSend<BillDto, object>('post', `/bills/${bill.id}/lines`, REFRESH);
  const set = (patch: Partial<ChargeForm>): void =>
    setForm((current) => ({ ...current, ...patch }));

  function submit(event: FormEvent): void {
    event.preventDefault();
    const result = buildChargePayload(form);
    if (!result.ok) return setProblem(result.error);
    if (needsManager(result.value) && !canApprove) {
      return setProblem('A charge this large needs a manager to add it.');
    }
    setProblem(null);
    add.mutate(result.value, {
      onSuccess: () => {
        toast.success(form.kind === 'discount' ? 'Discount added' : 'Charge added');
        onClose();
      },
    });
  }

  return (
    <Dialog title="Add a charge or discount" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Type"
            value={form.kind}
            onChange={(event) => set({ kind: event.target.value as ChargeForm['kind'] })}
          >
            <option value="charge">Charge</option>
            <option value="discount">Discount</option>
          </SelectField>
          <SelectField
            label="Counts as"
            value={form.category}
            onChange={(event) => set({ category: event.target.value as ManualLineCategory })}
          >
            {MANUAL_LINE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABELS[category]}
              </option>
            ))}
          </SelectField>
        </div>
        <TextField
          label="Description"
          value={form.description}
          maxLength={120}
          onChange={(event) => set({ description: event.target.value })}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Amount each, before tax (₹)"
            inputMode="decimal"
            value={form.amount}
            onChange={(event) => set({ amount: event.target.value })}
          />
          <TextField
            label="Quantity"
            inputMode="numeric"
            value={form.quantity}
            onChange={(event) => set({ quantity: event.target.value })}
          />
        </div>
        <TextField
          label="Reason"
          value={form.reason}
          maxLength={200}
          onChange={(event) => set({ reason: event.target.value })}
        />
        <p className="text-xs text-slate-500">
          GST is worked out for you from the property&rsquo;s tax rules.
        </p>
        {problem && (
          <p role="alert" className="text-sm text-rose-700">
            {problem}
          </p>
        )}
        {add.isError && <ErrorNotice error={add.error} />}
        <Actions onClose={onClose} busy={add.isPending} submit="Add to bill" />
      </form>
    </Dialog>
  );
}

export function PaymentDialog({ bill, onClose }: DialogProps) {
  const toast = useToast();
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState(paiseToRupees(Math.max(0, bill.balancePaise)));
  const [reference, setReference] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const pay = useSend<BillDto, object>('post', `/bills/${bill.id}/payments`, REFRESH);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const result = buildPaymentPayload({ method, amount, reference }, bill.balancePaise);
    if (!result.ok) return setProblem(result.error);
    setProblem(null);
    pay.mutate(result.value, {
      onSuccess: () => {
        toast.success('Payment recorded');
        onClose();
      },
    });
  }

  return (
    <Dialog title="Record a payment" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-sm text-slate-600">
          Balance due: <strong>{money(bill.balancePaise)}</strong>
        </p>
        <MethodField value={method} onChange={setMethod} />
        <TextField
          label="Amount received (₹)"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <TextField
          label="Reference (optional)"
          hint="A card slip number, UPI reference or receipt number"
          value={reference}
          maxLength={60}
          onChange={(event) => setReference(event.target.value)}
        />
        {problem && (
          <p role="alert" className="text-sm text-rose-700">
            {problem}
          </p>
        )}
        {pay.isError && <ErrorNotice error={pay.error} />}
        <Actions onClose={onClose} busy={pay.isPending} submit="Record payment" />
      </form>
    </Dialog>
  );
}

export function RefundDialog({ bill, onClose }: DialogProps) {
  const toast = useToast();
  const refundable = bill.paidPaise - bill.refundedPaise;
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState(paiseToRupees(Math.max(0, -bill.balancePaise)));
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const refund = useSend<BillDto, object>('post', `/bills/${bill.id}/refunds`, REFRESH);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const result = buildRefundPayload({ method, amount, reason }, refundable);
    if (!result.ok) return setProblem(result.error);
    setProblem(null);
    refund.mutate(result.value, {
      onSuccess: () => {
        toast.success('Refund recorded');
        onClose();
      },
    });
  }

  return (
    <Dialog title="Refund money to the guest" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-sm text-slate-600">
          Paid and not yet refunded: <strong>{money(refundable)}</strong>
        </p>
        <MethodField value={method} onChange={setMethod} />
        <TextField
          label="Amount (₹)"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <TextField
          label="Reason"
          value={reason}
          maxLength={200}
          onChange={(event) => setReason(event.target.value)}
        />
        {problem && (
          <p role="alert" className="text-sm text-rose-700">
            {problem}
          </p>
        )}
        {refund.isError && <ErrorNotice error={refund.error} />}
        <Actions onClose={onClose} busy={refund.isPending} submit="Record refund" tone="danger" />
      </form>
    </Dialog>
  );
}

export function CreditNoteDialog({ bill, line, onClose }: DialogProps & { line: BillLineDto }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const issue = useSend<BillDto, object>('post', `/bills/${bill.id}/credit-notes`, REFRESH);

  function submit(event: FormEvent): void {
    event.preventDefault();
    issue.mutate(
      { lineId: line.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Credit note issued');
          onClose();
        },
      },
    );
  }

  return (
    <Dialog title="Issue a credit note" onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-sm text-slate-700">
          This reverses <strong>{line.description}</strong> ({money(line.totalPaise)} including tax)
          on invoice {bill.invoice?.number}. It cannot be undone.
        </p>
        <TextField
          label="Reason"
          value={reason}
          maxLength={200}
          onChange={(event) => setReason(event.target.value)}
        />
        {issue.isError && <ErrorNotice error={issue.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={issue.isPending || reason.trim().length < 3}
          >
            Issue credit note
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CheckOutDialog({
  bill,
  canOverride,
  onClose,
}: DialogProps & { canOverride: boolean }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const checkOut = useSend<CheckOutResultDto, { overrideReason?: string }>(
    'post',
    `/bookings/${bill.bookingId}/check-out`,
    REFRESH,
  );
  const settled = bill.balancePaise === 0;
  const blocked = !settled && !canOverride;

  function submit(event: FormEvent): void {
    event.preventDefault();
    checkOut.mutate(settled ? {} : { overrideReason: reason.trim() }, {
      onSuccess: (done) => {
        toast.success(`Room ${done.roomNumber} checked out and sent for cleaning`);
        onClose();
      },
      onError: (error) => toast.error(errorText(error)),
    });
  }

  return (
    <Dialog title={`Check out room ${bill.roomNumber}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={submit}>
        <p className="text-sm text-slate-700">
          This issues the invoice, marks room {bill.roomNumber} for cleaning and puts any unused
          nights back on sale.
        </p>
        {settled ? (
          <p className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">
            The bill is settled. Total {money(bill.totals.totalPaise)}.
          </p>
        ) : (
          <div role="alert" className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">
            {bill.balancePaise > 0
              ? `${money(bill.balancePaise)} is still owed.`
              : `The guest is owed ${money(-bill.balancePaise)}.`}{' '}
            {blocked
              ? 'Settle the balance first, or ask a manager to check the guest out.'
              : 'Settle it first, or give a reason to check out anyway. The reason is recorded.'}
          </div>
        )}
        {!settled && canOverride && (
          <TextField
            label="Reason for checking out with a balance"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
        {checkOut.isError && <ErrorNotice error={checkOut.error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button
            type="submit"
            variant={settled ? 'primary' : 'danger'}
            disabled={checkOut.isPending || blocked || (!settled && reason.trim().length < 3)}
          >
            {settled ? 'Check out' : 'Check out anyway'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
