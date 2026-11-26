import type { BillSummaryDto, PaymentDto, PaymentsSummaryDto } from '@hospitality/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createFakeApi, staffDto, type FakeApi } from '../../test/fakeApi';
import { mountAt } from '../../test/mount';

function summary(over: Partial<BillSummaryDto> = {}): BillSummaryDto {
  return {
    id: 'bill1',
    bookingId: 'bk1',
    bookingCode: 'HP-7H3K9Q',
    guestName: 'Asha Rao',
    roomNumber: '204',
    status: 'open',
    invoiceNumber: null,
    totalPaise: 262_500,
    balancePaise: 162_500,
    createdAt: '2026-12-01T05:00:00.000Z',
    ...over,
  };
}

function payment(over: Partial<PaymentDto> = {}): PaymentDto {
  return {
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
    ...over,
  };
}

const paymentsSummary: PaymentsSummaryDto = {
  date: '2026-12-01',
  netByMethod: { upi: 100_000, cash: -10_000 },
  collectedPaise: 100_000,
  refundedPaise: 10_000,
  netPaise: 90_000,
  count: 2,
};

describe('the bills list', () => {
  function serve(api: FakeApi, items: BillSummaryDto[]) {
    const queries: Record<string, unknown>[] = [];
    api.on('GET /bills', (_body: unknown, query: unknown) => {
      queries.push(query as Record<string, unknown>);
      return { data: items, meta: { total: items.length, page: 1, limit: 20 } };
    });
    return queries;
  }

  it('shows each bill with its total and balance, linking to the bill', async () => {
    const api = createFakeApi(staffDto('front_desk'));
    serve(api, [
      summary(),
      summary({
        id: 'bill2',
        bookingId: 'bk2',
        bookingCode: 'HP-2222',
        status: 'finalized',
        invoiceNumber: 'INV/2026-27/000003',
        balancePaise: 0,
      }),
    ]);
    mountAt(api, '/bills');
    expect(await screen.findByRole('heading', { name: 'Bills' })).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'HP-7H3K9Q' });
    expect(link).toHaveAttribute('href', '/bills/bk1');
    expect(screen.getByText('INV/2026-27/000003')).toBeInTheDocument();
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Open')).toBeInTheDocument();
    expect(table.getByText('Issued')).toBeInTheDocument();
    expect(screen.getByText('₹1,625.00')).toBeInTheDocument();
  });

  it('asks the server for only the chosen status', async () => {
    const user = userEvent.setup();
    const api = createFakeApi(staffDto('manager'));
    const queries = serve(api, [summary()]);
    mountAt(api, '/bills');
    await screen.findByRole('link', { name: 'HP-7H3K9Q' });
    await user.selectOptions(screen.getByLabelText('Status'), 'open');
    await waitFor(() => expect(queries.some((query) => query.status === 'open')).toBe(true));
  });

  it('says so when there are no bills', async () => {
    const api = createFakeApi(staffDto('front_desk'));
    serve(api, []);
    mountAt(api, '/bills');
    expect(await screen.findByText(/No bills yet/)).toBeInTheDocument();
  });
});

describe('the payments ledger', () => {
  function serve(api: FakeApi, items: PaymentDto[]) {
    const queries: { path: string; query: Record<string, unknown> }[] = [];
    api.on('GET /payments', (_body: unknown, query: unknown) => {
      queries.push({ path: '/payments', query: query as Record<string, unknown> });
      return { data: items, meta: { total: items.length, page: 1, limit: 100 } };
    });
    api.on('GET /payments/summary', (_body: unknown, query: unknown) => {
      queries.push({ path: '/payments/summary', query: query as Record<string, unknown> });
      return paymentsSummary;
    });
    return queries;
  }

  it('shows the day’s totals by method and every payment and refund', async () => {
    const api = createFakeApi(staffDto('front_desk'));
    serve(api, [
      payment(),
      payment({
        id: 'p2',
        kind: 'refund',
        method: 'cash',
        amountPaise: 10_000,
        reference: '',
        reason: 'Goodwill',
        recordedBy: 'Dev Manager',
      }),
    ]);
    mountAt(api, '/payments');
    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeInTheDocument();

    const net = within(await screen.findByRole('region', { name: 'Net for the day' }));
    expect(net.getByText('₹900.00')).toBeInTheDocument();
    expect(net.getByText('UPI')).toBeInTheDocument();
    expect(net.getByText('Cash')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Collected' })).getByText('₹1,000.00'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Refunded' })).getByText('₹100.00'),
    ).toBeInTheDocument();

    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText('UTR 42')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Refund')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Goodwill')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText(/− ₹100.00/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'HP-7H3K9Q' })[0]).toHaveAttribute(
      'href',
      '/bills/bk1',
    );
  });

  it('asks for the day that was picked', async () => {
    const api = createFakeApi(staffDto('front_desk'));
    const queries = serve(api, [payment()]);
    mountAt(api, '/payments');
    await screen.findByText('UTR 42');
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-11-30' } });
    await waitFor(() =>
      expect(
        queries.filter((entry) => entry.query.date === '2026-11-30').map((entry) => entry.path),
      ).toEqual(expect.arrayContaining(['/payments', '/payments/summary'])),
    );
  });

  it('says so when nothing was taken that day', async () => {
    const api = createFakeApi(staffDto('manager'));
    serve(api, []);
    mountAt(api, '/payments');
    expect(await screen.findByText('No payments on this day.')).toBeInTheDocument();
  });

  it('is closed to the other departments', async () => {
    for (const role of ['kitchen', 'housekeeping', 'maintenance', 'spa_recreation'] as const) {
      const api = createFakeApi(staffDto(role));
      serve(api, []);
      mountAt(api, '/payments');
      await waitFor(() =>
        expect(api.calls.some((call) => call.path.startsWith('/payments'))).toBe(false),
      );
    }
  });
});
