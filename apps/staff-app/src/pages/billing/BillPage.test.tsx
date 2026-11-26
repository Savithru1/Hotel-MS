import type { StaffRole } from '@hospitality/constants';
import type { BillDto, BillLineDto, BookingDto } from '@hospitality/shared-types';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createFakeApi, staffDto, type FakeApi } from '../../test/fakeApi';
import { mountAt } from '../../test/mount';

function line(over: Partial<BillLineDto> = {}): BillLineDto {
  return {
    id: 'l1',
    kind: 'room',
    category: 'room',
    description: 'Room 204 · night of 2026-12-01',
    serviceDate: '2026-12-01',
    quantity: 1,
    unitPaise: 250_000,
    taxablePaise: 250_000,
    ratePercent: 5,
    cgstPaise: 6_250,
    sgstPaise: 6_250,
    igstPaise: 0,
    taxPaise: 12_500,
    totalPaise: 262_500,
    sacCode: '996311',
    reason: null,
    approvedBy: null,
    manual: false,
    creditNoteNumber: null,
    postedAt: '2026-12-01T05:00:00.000Z',
    ...over,
  };
}

function bill(over: Partial<BillDto> = {}): BillDto {
  return {
    id: 'bill1',
    bookingId: 'bk1',
    bookingCode: 'HP-7H3K9Q',
    guest: { name: 'Asha Rao', phone: '+917000000001', gstin: null },
    roomNumber: '204',
    checkInDate: '2026-12-01',
    checkOutDate: '2026-12-02',
    nights: 1,
    status: 'open',
    lines: [line()],
    totals: {
      taxablePaise: 250_000,
      cgstPaise: 6_250,
      sgstPaise: 6_250,
      igstPaise: 0,
      taxPaise: 12_500,
      subtotalPaise: 262_500,
      roundOffPaise: 0,
      totalPaise: 262_500,
    },
    paidPaise: 0,
    refundedPaise: 0,
    creditNotePaise: 0,
    balancePaise: 262_500,
    payments: [],
    creditNotes: [],
    invoice: null,
    createdAt: '2026-12-01T05:00:00.000Z',
    updatedAt: '2026-12-01T05:00:00.000Z',
    ...over,
  };
}

const finalized = (over: Partial<BillDto> = {}): BillDto =>
  bill({
    status: 'finalized',
    invoice: {
      number: 'INV/2026-27/000007',
      financialYear: '2026-27',
      issuedAt: '2026-12-02T05:00:00.000Z',
      supplier: {
        legalName: 'Grand Plaza Hotels Pvt Ltd',
        gstin: '29ABCDE1234F1Z5',
        stateName: 'Karnataka',
        address: '1 MG Road, Bengaluru',
      },
      placeOfSupplyState: 'Karnataka',
      intraState: true,
      totals: bill().totals,
    },
    ...over,
  });

function open(role: StaffRole, shown: BillDto, status: BookingDto['status'] = 'checked_in') {
  const api: FakeApi = createFakeApi(staffDto(role));
  api.on('GET /bills/by-booking/bk1', () => shown);
  api.on('GET /bookings/bk1', { id: 'bk1', status } as BookingDto);
  mountAt(api, '/bills/bk1');
  return api;
}

const posted = (api: FakeApi, method: string, path: string) =>
  api.calls.find((call) => call.method === method && call.path === path);

describe('the bill screen', () => {
  it('shows each line with its tax, the totals and what is still owed', async () => {
    open('front_desk', bill());
    expect(await screen.findByRole('heading', { name: 'Bill for Asha Rao' })).toBeInTheDocument();
    expect(screen.getByText('Room 204 · night of 2026-12-01')).toBeInTheDocument();
    expect(screen.getByText(/SAC 996311/)).toBeInTheDocument();
    expect(screen.getByText('(5%)')).toBeInTheDocument();
    const totals = within(screen.getByRole('region', { name: 'Totals' }));
    expect(totals.getByText('CGST')).toBeInTheDocument();
    expect(totals.getByText('SGST')).toBeInTheDocument();
    expect(totals.queryByText('IGST')).not.toBeInTheDocument();
    expect(totals.getByText('Balance due')).toBeInTheDocument();
    expect(totals.getAllByText('₹2,625.00').length).toBeGreaterThan(0);
  });

  it('shows IGST instead of CGST and SGST for a supply to another state', async () => {
    open(
      'front_desk',
      bill({
        totals: { ...bill().totals, cgstPaise: 0, sgstPaise: 0, igstPaise: 12_500 },
      }),
    );
    const totals = within(await screen.findByRole('region', { name: 'Totals' }));
    expect(totals.getByText('IGST')).toBeInTheDocument();
    expect(totals.queryByText('CGST')).not.toBeInTheDocument();
  });

  it('lists payments and refunds', async () => {
    open(
      'front_desk',
      bill({
        paidPaise: 100_000,
        refundedPaise: 10_000,
        balancePaise: 172_500,
        payments: [
          {
            id: 'p1',
            billId: 'bill1',
            bookingId: 'bk1',
            bookingCode: 'HP-7H3K9Q',
            guestName: 'Asha Rao',
            kind: 'payment',
            method: 'upi',
            amountPaise: 100_000,
            reference: 'UTR 42',
            reason: null,
            recordedBy: 'Dev Desk',
            createdAt: '2026-12-01T06:00:00.000Z',
          },
          {
            id: 'p2',
            billId: 'bill1',
            bookingId: 'bk1',
            bookingCode: 'HP-7H3K9Q',
            guestName: 'Asha Rao',
            kind: 'refund',
            method: 'cash',
            amountPaise: 10_000,
            reference: '',
            reason: 'Goodwill',
            recordedBy: 'Dev Manager',
            createdAt: '2026-12-01T07:00:00.000Z',
          },
        ],
      }),
    );
    const card = within(await screen.findByRole('region', { name: 'Payments' }));
    expect(card.getByText(/Payment · UPI/)).toBeInTheDocument();
    expect(card.getByText(/UTR 42/)).toBeInTheDocument();
    expect(card.getByText(/Refund · Cash/)).toBeInTheDocument();
  });
});

describe('taking a payment', () => {
  it('starts with the balance and sends the amount in whole paise', async () => {
    const user = userEvent.setup();
    const api = open('front_desk', bill());
    api.on('POST /bills/bill1/payments', () => bill({ balancePaise: 0, paidPaise: 262_500 }));

    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('Amount received (₹)')).toHaveValue('2625');
    await user.type(dialog.getByLabelText(/Reference/), 'Receipt 9');
    await user.click(dialog.getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(posted(api, 'POST', '/bills/bill1/payments')).toBeDefined());
    expect(posted(api, 'POST', '/bills/bill1/payments')?.body).toEqual({
      method: 'cash',
      amountPaise: 262_500,
      reference: 'Receipt 9',
    });
  });

  it('refuses more than is owed without calling the server', async () => {
    const user = userEvent.setup();
    const api = open('front_desk', bill());
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = within(await screen.findByRole('dialog'));
    const amount = dialog.getByLabelText('Amount received (₹)');
    await user.clear(amount);
    await user.type(amount, '9999');
    await user.click(dialog.getByRole('button', { name: 'Record payment' }));

    expect(await dialog.findByRole('alert')).toHaveTextContent(/more than the balance/);
    expect(posted(api, 'POST', '/bills/bill1/payments')).toBeUndefined();
  });

  it('shows the server’s reason when it refuses', async () => {
    const user = userEvent.setup();
    const api = open('front_desk', bill());
    api.on('POST /bills/bill1/payments', () => {
      throw new ApiError(409, 'overpayment', 'Someone else just paid this bill');
    });
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Record payment' }));
    expect(await dialog.findByText('Someone else just paid this bill')).toBeInTheDocument();
  });

  it('offers no payment button once the bill is settled', async () => {
    open('front_desk', bill({ balancePaise: 0, paidPaise: 262_500 }));
    await screen.findByRole('heading', { name: 'Bill for Asha Rao' });
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });
});

describe('adding a charge', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, amount: string) {
    await user.click(await screen.findByRole('button', { name: 'Add charge or discount' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Description'), 'Laundry');
    await user.type(dialog.getByLabelText('Amount each, before tax (₹)'), amount);
    await user.type(dialog.getByLabelText('Reason'), 'Guest request');
    return dialog;
  }

  it('sends the rupees as paise and lets the server work out the tax', async () => {
    const user = userEvent.setup();
    const api = open('front_desk', bill());
    api.on('POST /bills/bill1/lines', () => bill());
    const dialog = await fill(user, '250.50');
    await user.click(dialog.getByRole('button', { name: 'Add to bill' }));

    await waitFor(() => expect(posted(api, 'POST', '/bills/bill1/lines')).toBeDefined());
    const body = posted(api, 'POST', '/bills/bill1/lines')?.body as Record<string, unknown>;
    expect(body).toEqual({
      kind: 'charge',
      category: 'other',
      description: 'Laundry',
      amountPaise: 25_050,
      quantity: 1,
      reason: 'Guest request',
    });
    expect(Object.keys(body)).not.toContain('taxPaise');
  });

  it('asks the front desk to get a manager for a large charge', async () => {
    const user = userEvent.setup();
    const api = open('front_desk', bill());
    const dialog = await fill(user, '5000.01');
    await user.click(dialog.getByRole('button', { name: 'Add to bill' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(/needs a manager/);
    expect(posted(api, 'POST', '/bills/bill1/lines')).toBeUndefined();
  });

  it('lets a manager add the same large charge', async () => {
    const user = userEvent.setup();
    const api = open('manager', bill());
    api.on('POST /bills/bill1/lines', () => bill());
    const dialog = await fill(user, '5000.01');
    await user.click(dialog.getByRole('button', { name: 'Add to bill' }));
    await waitFor(() => expect(posted(api, 'POST', '/bills/bill1/lines')).toBeDefined());
  });

  it('removes only the lines that were added by hand', async () => {
    const user = userEvent.setup();
    const api = open(
      'front_desk',
      bill({
        lines: [line(), line({ id: 'l2', kind: 'charge', manual: true, description: 'Laundry' })],
      }),
    );
    api.on('DELETE /bills/bill1/lines/l2', () => bill());
    expect(await screen.findAllByRole('button', { name: 'Remove' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(posted(api, 'DELETE', '/bills/bill1/lines/l2')).toBeDefined());
  });
});

describe('refunds and credit notes', () => {
  const paid = bill({ paidPaise: 100_000, balancePaise: 162_500 });

  it('are only offered to managers', async () => {
    open('front_desk', paid);
    await screen.findByRole('heading', { name: 'Bill for Asha Rao' });
    expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
  });

  it('lets a manager refund up to what was paid', async () => {
    const user = userEvent.setup();
    const api = open('manager', paid);
    api.on('POST /bills/bill1/refunds', () => paid);
    await user.click(await screen.findByRole('button', { name: 'Refund' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.clear(dialog.getByLabelText('Amount (₹)'));
    await user.type(dialog.getByLabelText('Amount (₹)'), '1500');
    await user.type(dialog.getByLabelText('Reason'), 'Goodwill');
    await user.click(dialog.getByRole('button', { name: 'Record refund' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(/Only ₹1000/);
    expect(posted(api, 'POST', '/bills/bill1/refunds')).toBeUndefined();

    await user.clear(dialog.getByLabelText('Amount (₹)'));
    await user.type(dialog.getByLabelText('Amount (₹)'), '500');
    await user.click(dialog.getByRole('button', { name: 'Record refund' }));
    await waitFor(() => expect(posted(api, 'POST', '/bills/bill1/refunds')).toBeDefined());
    expect(posted(api, 'POST', '/bills/bill1/refunds')?.body).toEqual({
      method: 'cash',
      amountPaise: 50_000,
      reason: 'Goodwill',
    });
  });

  it('shows an issued invoice with its print button, and credit notes for managers only', async () => {
    open('front_desk', finalized({ balancePaise: 0, paidPaise: 262_500 }), 'checked_out');
    // Once on screen and once in the print-only header.
    expect(await screen.findAllByText('INV/2026-27/000007')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Print invoice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Credit note' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add charge or discount' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check out' })).not.toBeInTheDocument();
  });

  it('lets a manager reverse a line with a credit note', async () => {
    const user = userEvent.setup();
    const api = open('manager', finalized({ balancePaise: 0, paidPaise: 262_500 }), 'checked_out');
    api.on('POST /bills/bill1/credit-notes', () => finalized());
    await user.click(await screen.findByRole('button', { name: 'Credit note' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Reason'), 'Billed twice');
    await user.click(dialog.getByRole('button', { name: 'Issue credit note' }));
    await waitFor(() => expect(posted(api, 'POST', '/bills/bill1/credit-notes')).toBeDefined());
    expect(posted(api, 'POST', '/bills/bill1/credit-notes')?.body).toEqual({
      lineId: 'l1',
      reason: 'Billed twice',
    });
  });
});

describe('checking out', () => {
  it('checks out a settled bill without asking for a reason', async () => {
    const user = userEvent.setup();
    const api = open('front_desk', bill({ balancePaise: 0, paidPaise: 262_500 }));
    api.on('POST /bookings/bk1/check-out', () => ({
      bookingId: 'bk1',
      roomNumber: '204',
      status: 'checked_out',
    }));
    await user.click(await screen.findByRole('button', { name: 'Check out' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/The bill is settled/)).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Check out' }));
    await waitFor(() => expect(posted(api, 'POST', '/bookings/bk1/check-out')).toBeDefined());
    expect(posted(api, 'POST', '/bookings/bk1/check-out')?.body).toEqual({});
  });

  it('stops the front desk when money is still owed', async () => {
    const user = userEvent.setup();
    const api = open('front_desk', bill());
    await user.click(await screen.findByRole('button', { name: 'Check out' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('alert')).toHaveTextContent(/still owed/);
    expect(dialog.getByRole('button', { name: 'Check out anyway' })).toBeDisabled();
    expect(posted(api, 'POST', '/bookings/bk1/check-out')).toBeUndefined();
  });

  it('lets a manager check out with a balance, but only with a reason', async () => {
    const user = userEvent.setup();
    const api = open('manager', bill());
    api.on('POST /bookings/bk1/check-out', () => ({
      bookingId: 'bk1',
      roomNumber: '204',
      status: 'checked_out',
    }));
    await user.click(await screen.findByRole('button', { name: 'Check out' }));
    const dialog = within(await screen.findByRole('dialog'));
    const go = dialog.getByRole('button', { name: 'Check out anyway' });
    expect(go).toBeDisabled();
    await user.type(
      dialog.getByLabelText('Reason for checking out with a balance'),
      'Company will pay',
    );
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() => expect(posted(api, 'POST', '/bookings/bk1/check-out')).toBeDefined());
    expect(posted(api, 'POST', '/bookings/bk1/check-out')?.body).toEqual({
      overrideReason: 'Company will pay',
    });
  });

  it('does not offer check-out for a guest who has already left', async () => {
    open('front_desk', finalized({ balancePaise: 0 }), 'checked_out');
    await screen.findAllByText('INV/2026-27/000007');
    expect(screen.queryByRole('button', { name: 'Check out' })).not.toBeInTheDocument();
  });
});

describe('who can reach the bill screens', () => {
  it('turns the other departments away', async () => {
    for (const role of ['kitchen', 'housekeeping', 'spa_recreation'] as const) {
      const api = createFakeApi(staffDto(role));
      mountAt(api, '/bills/bk1');
      await waitFor(() => expect(api.calls.some((c) => c.path.startsWith('/bills'))).toBe(false));
    }
  });
});
