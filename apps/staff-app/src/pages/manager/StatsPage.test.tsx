import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createFakeApi, staffDto } from '../../test/fakeApi';
import { occupancyFixture, responseTimesFixture, revenueFixture } from '../../test/managerFixtures';
import { mountAt } from '../../test/mount';
import { dateTimeLabel, todayLocal } from './format';

type Queries = Record<string, unknown[]>;

function open(overrides: { revenue?: unknown; responseTimes?: unknown; occupancy?: unknown } = {}) {
  const api = createFakeApi(staffDto('manager'));
  const queries: Queries = { occupancy: [], revenue: [], responseTimes: [] };
  const serve = (key: keyof Queries, route: string, fallback: unknown, given: unknown) =>
    api.on(route, (_body: unknown, query: unknown) => {
      queries[key]?.push(query);
      const value = given === undefined ? fallback : given;
      return typeof value === 'function' ? (value as () => unknown)() : value;
    });
  serve('occupancy', 'GET /manager/stats/occupancy', occupancyFixture(), overrides.occupancy);
  serve('revenue', 'GET /manager/stats/revenue', revenueFixture(), overrides.revenue);
  serve(
    'responseTimes',
    'GET /manager/stats/response-times',
    responseTimesFixture(),
    overrides.responseTimes,
  );
  mountAt(api, '/manager/stats');
  return { api, queries };
}

const row = (table: HTMLElement, name: string) => within(within(table).getByRole('row', { name }));

const setDates = (from: string, to: string): void => {
  fireEvent.change(screen.getByLabelText('From'), { target: { value: from } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: to } });
};

describe('the statistics page', () => {
  it('asks for today by default, in all three reports', async () => {
    const { queries } = open();
    await screen.findByRole('table', { name: 'Occupancy by day' });
    const today = todayLocal();
    expect(queries.occupancy[0]).toEqual({ from: today, to: today });
    expect(queries.revenue[0]).toEqual({ from: today, to: today });
    expect(queries.responseTimes[0]).toEqual({ from: today, to: today });
  });

  it('shows occupancy per day, flags the basis, and explains what sellable means', async () => {
    open();
    const table = await screen.findByRole('table', { name: 'Occupancy by day' });
    const past = row(table, '2026-11-26');
    expect(past.getByText('9')).toBeInTheDocument();
    expect(past.getByText('24')).toBeInTheDocument();
    expect(past.getByText('37.5%')).toBeInTheDocument();
    expect(past.getByText('Actual')).toBeInTheDocument();
    const future = row(table, '2026-11-28');
    expect(future.getByText('12')).toBeInTheDocument();
    expect(future.getByText('50%')).toBeInTheDocument();
    expect(future.getByText('On the books')).toBeInTheDocument();
    expect(screen.getByText(/Sellable is today's count of active rooms/)).toBeInTheDocument();
  });

  it('says No data for a day without sellable rooms instead of 0%', async () => {
    const data = occupancyFixture();
    open({
      occupancy: {
        ...data,
        days: [{ date: '2026-11-26', occupied: 0, sellable: 0, rateBp: null, basis: 'actual' }],
      },
    });
    const table = await screen.findByRole('table', { name: 'Occupancy by day' });
    expect(row(table, '2026-11-26').getByText('No data')).toBeInTheDocument();
    expect(within(table).queryByText('0%')).not.toBeInTheDocument();
  });

  it('shows revenue by day and department with taxable amount, GST and total in rupees', async () => {
    open();
    const table = await screen.findByRole('table', { name: 'Revenue by day and department' });
    // 200000 paise taxable + 24000 paise GST = 224000 paise
    const room = row(table, '2026-11-26 Room');
    expect(room.getByText('₹2,000.00')).toBeInTheDocument();
    expect(room.getByText('₹240.00')).toBeInTheDocument();
    expect(room.getByText('₹2,240.00')).toBeInTheDocument();
    const food = row(table, '2026-11-26 Food');
    expect(food.getByText('₹500.00')).toBeInTheDocument();
    expect(food.getByText('₹25.00')).toBeInTheDocument();
    expect(food.getByText('₹525.00')).toBeInTheDocument();
    const spa = row(table, '2026-11-27 Spa and recreation');
    expect(spa.getByText('₹800.00')).toBeInTheDocument();
    expect(spa.getByText('₹144.00')).toBeInTheDocument();
    expect(spa.getByText('₹944.00')).toBeInTheDocument();
    const dayTotal = row(table, '2026-11-26 Day total');
    expect(dayTotal.getByText('₹2,500.00')).toBeInTheDocument();
    expect(dayTotal.getByText('₹265.00')).toBeInTheDocument();
    expect(dayTotal.getByText('₹2,765.00')).toBeInTheDocument();
    const grand = row(table, 'Whole range Total');
    expect(grand.getByText('₹3,400.00')).toBeInTheDocument();
    expect(grand.getByText('₹427.00')).toBeInTheDocument();
    expect(grand.getByText('₹3,827.00')).toBeInTheDocument();
  });

  it('shows cash received and refunded separately from revenue', async () => {
    open();
    const table = await screen.findByRole('table', { name: 'Cash received and refunded' });
    const day = row(table, '2026-11-26');
    expect(day.getByText('₹3,000.00')).toBeInTheDocument();
    expect(day.getByText('₹123.45')).toBeInTheDocument();
  });

  it('says when the bills were last brought up to date', async () => {
    const synced = revenueFixture().lastSyncedAt as string;
    open();
    expect(await screen.findByText(`Posted up to ${dateTimeLabel(synced)}`)).toBeInTheDocument();
  });

  it('says plainly when the bills have never been synced', async () => {
    open({ revenue: revenueFixture({ lastSyncedAt: null }) });
    expect(await screen.findByText('Bills have not been synced yet')).toBeInTheDocument();
    expect(screen.queryByText(/Posted up to/)).not.toBeInTheDocument();
  });

  it('shows response times as minutes and seconds, with the number of requests', async () => {
    open();
    const table = await screen.findByRole('table', { name: 'Response times' });
    const housekeeping = row(table, 'Housekeeping');
    expect(housekeeping.getByText('7')).toBeInTheDocument();
    expect(housekeeping.getByText('10 min')).toBeInTheDocument();
    expect(housekeeping.getByText('30 min 5 s')).toBeInTheDocument();
    const maintenance = row(table, 'Maintenance');
    expect(maintenance.getByText('3')).toBeInTheDocument();
    expect(maintenance.getByText('45 s')).toBeInTheDocument();
    expect(maintenance.getByText('2 h 5 min')).toBeInTheDocument();
  });

  it('shows No data, not 0, for averages the server could not work out', async () => {
    open();
    const table = await screen.findByRole('table', { name: 'Response times' });
    const kitchen = row(table, 'Kitchen');
    expect(kitchen.getAllByText('No data')).toHaveLength(2);
    expect(kitchen.getByText('0')).toBeInTheDocument(); // n really is 0
    expect(kitchen.queryByText('0 s')).not.toBeInTheDocument();
  });

  it('sends a valid range to all three reports', async () => {
    const { queries } = open();
    await screen.findByRole('table', { name: 'Response times' });
    setDates('2026-11-01', '2026-11-27');
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() =>
      expect(queries.revenue).toContainEqual({ from: '2026-11-01', to: '2026-11-27' }),
    );
    expect(queries.occupancy).toContainEqual({ from: '2026-11-01', to: '2026-11-27' });
    expect(queries.responseTimes).toContainEqual({ from: '2026-11-01', to: '2026-11-27' });
  });

  it('accepts exactly 92 days but blocks 93 without asking the server', async () => {
    const { queries } = open();
    await screen.findByRole('table', { name: 'Response times' });

    setDates('2026-01-01', '2026-04-03');
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('the range can cover at most 92 days')).toBeInTheDocument();
    expect(queries.revenue).not.toContainEqual({ from: '2026-01-01', to: '2026-04-03' });

    setDates('2026-01-01', '2026-04-02');
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() =>
      expect(queries.revenue).toContainEqual({ from: '2026-01-01', to: '2026-04-02' }),
    );
    expect(screen.queryByText('the range can cover at most 92 days')).not.toBeInTheDocument();
  });

  it('blocks a range that runs backwards', async () => {
    const { queries } = open();
    await screen.findByRole('table', { name: 'Response times' });
    setDates('2026-11-20', '2026-11-10');
    await userEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('must not be after "to"')).toBeInTheDocument();
    expect(queries.revenue).not.toContainEqual({ from: '2026-11-20', to: '2026-11-10' });
  });

  it('keeps the other reports when one fails, and lets that one be retried', async () => {
    let failing = true;
    open({
      revenue: () => {
        if (failing) throw new ApiError(403, 'forbidden', 'Revenue is not available to you.');
        return revenueFixture();
      },
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Revenue is not available to you.');
    expect(await screen.findByRole('table', { name: 'Occupancy by day' })).toBeInTheDocument();
    failing = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('table', { name: 'Revenue by day and department' }),
    ).toBeInTheDocument();
  });
});
