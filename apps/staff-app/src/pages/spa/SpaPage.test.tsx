import type { StaffRole } from '@hospitality/constants';
import type { FacilityBookingDto, FacilityDto } from '@hospitality/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createFakeApi, staffDto, type FakeApi } from '../../test/fakeApi';
import { mountAt } from '../../test/mount';

function booking(overrides: Partial<FacilityBookingDto> = {}): FacilityBookingDto {
  return {
    id: 'b1',
    code: 'FB-7H3K9Q',
    facilityId: 'f1',
    facilityName: 'Ayurvedic Spa',
    facilityType: 'spa',
    roomId: 'r1',
    roomNumber: '204',
    bookingId: 'bk1',
    guestName: 'Asha Rao',
    date: '2026-12-01',
    startTime: '10:00',
    endTime: '11:00',
    participants: 2,
    unitPricePaise: 150_000,
    totalPaise: 300_000,
    notes: 'Quiet room please',
    status: 'requested',
    cancelReason: null,
    source: 'front_desk',
    createdAt: '2026-11-30T05:00:00.000Z',
    updatedAt: '2026-11-30T05:00:00.000Z',
    confirmedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

const spaFacility: FacilityDto = {
  id: 'f1',
  name: 'Ayurvedic Spa',
  type: 'spa',
  description: '',
  capacity: 1,
  slotMinutes: 60,
  opensAt: '09:00',
  closesAt: '18:00',
  pricePaise: 150_000,
  active: true,
  createdAt: '',
  updatedAt: '',
};
const poolFacility: FacilityDto = {
  ...spaFacility,
  id: 'f2',
  name: 'Rooftop Pool',
  type: 'pool',
  capacity: 8,
};

const HOLDING = ['requested', 'confirmed', 'active'];

function serve(
  api: FakeApi,
  bookings: FacilityBookingDto[],
): { queries: Record<string, unknown>[] } {
  const queries: Record<string, unknown>[] = [];
  api.on('GET /facility-bookings', (_body: unknown, query: unknown) => {
    queries.push(query as Record<string, unknown>);
    const asked = query as { facilityId?: string };
    const items = bookings.filter((b) => !asked.facilityId || b.facilityId === asked.facilityId);
    return { data: items, meta: { total: items.length, page: 1, limit: 100 } };
  });
  const count = (status: string) => bookings.filter((b) => b.status === status).length;
  api.on('GET /facility-bookings/summary', {
    date: '2026-12-01',
    byStatus: {
      requested: count('requested'),
      confirmed: count('confirmed'),
      active: count('active'),
      completed: count('completed'),
      cancelled: count('cancelled'),
      no_show: count('no_show'),
    },
    participantsExpected: bookings
      .filter((b) => HOLDING.includes(b.status))
      .reduce((sum, b) => sum + b.participants, 0),
  });
  api.on('GET /facilities', {
    data: [spaFacility, poolFacility],
    meta: { total: 2, page: 1, limit: 100 },
  });
  api.on('GET /rooms', {
    data: [
      {
        id: 'r1',
        number: '204',
        floor: 2,
        roomTypeId: 't',
        roomTypeName: 'Deluxe',
        status: 'occupied',
        active: true,
      },
      {
        id: 'r2',
        number: '205',
        floor: 2,
        roomTypeId: 't',
        roomTypeName: 'Deluxe',
        status: 'available',
        active: true,
      },
    ],
    meta: { total: 2, page: 1, limit: 100 },
  });
  return { queries };
}

function open(role: StaffRole, bookings: FacilityBookingDto[]) {
  const api = createFakeApi(staffDto(role));
  const seen = serve(api, bookings);
  mountAt(api, '/spa');
  return { api, ...seen };
}

const column = async (name: string) => within(await screen.findByRole('region', { name }));

describe('the spa and recreation screen', () => {
  it('shows each booking in the column for its status, with what the team needs', async () => {
    open('spa_recreation', [
      booking(),
      booking({ id: 'b2', code: 'FB-AAAAAA', roomNumber: '305', status: 'confirmed' }),
      booking({ id: 'b3', code: 'FB-BBBBBB', roomNumber: '102', status: 'active' }),
      booking({ id: 'b4', code: 'FB-CCCCCC', roomNumber: '110', status: 'completed' }),
      booking({
        id: 'b5',
        code: 'FB-DDDDDD',
        roomNumber: '111',
        status: 'cancelled',
        cancelReason: 'Guest unwell',
      }),
      booking({ id: 'b6', code: 'FB-EEEEEE', roomNumber: '112', status: 'no_show' }),
    ]);
    expect(await screen.findByRole('heading', { name: 'Spa & recreation' })).toBeInTheDocument();

    const requested = await column('Requested');
    expect(await requested.findByText('Room 204')).toBeInTheDocument();
    expect(requested.getByText('Asha Rao')).toBeInTheDocument();
    expect(requested.getByText('FB-7H3K9Q')).toBeInTheDocument();
    expect(requested.getByText('10:00–11:00')).toBeInTheDocument();
    expect(requested.getByText('Ayurvedic Spa')).toBeInTheDocument();
    expect(requested.getByText(/2 people/)).toBeInTheDocument();
    expect(requested.getByText('₹3,000.00')).toBeInTheDocument();
    expect(requested.getByText(/Quiet room please/)).toBeInTheDocument();

    expect((await column('Confirmed')).getByText('Room 305')).toBeInTheDocument();
    expect((await column('In progress')).getByText('Room 102')).toBeInTheDocument();
    expect((await column('Completed')).getByText('Room 110')).toBeInTheDocument();
    const closed = await column('Cancelled and no-shows');
    expect(closed.getByText('Room 111')).toBeInTheDocument();
    expect(closed.getByText('Room 112')).toBeInTheDocument();
    expect(closed.getByText(/Guest unwell/)).toBeInTheDocument();
  });

  it('says so when a column is empty', async () => {
    open('spa_recreation', []);
    expect(await screen.findByText('No requests waiting.')).toBeInTheDocument();
    expect(screen.getByText('Nothing confirmed.')).toBeInTheDocument();
    expect(screen.getByText('Nothing in progress.')).toBeInTheDocument();
  });

  it('shows how many bookings are open and how many people are expected', async () => {
    open('spa_recreation', [
      booking(),
      booking({ id: 'b2', status: 'confirmed', participants: 3 }),
      booking({ id: 'b3', status: 'active', participants: 1 }),
      booking({ id: 'b4', status: 'cancelled', participants: 5 }),
    ]);
    expect(await screen.findByText('3 open · 6 people expected')).toBeInTheDocument();
  });

  it('lets the spa team confirm, start and finish a session, and mark a no-show', async () => {
    const user = userEvent.setup();
    const { api } = open('spa_recreation', [
      booking({ id: 'a', code: 'FB-AAAAAA', status: 'requested' }),
      booking({ id: 'b', code: 'FB-BBBBBB', status: 'confirmed' }),
      booking({ id: 'c', code: 'FB-CCCCCC', status: 'active' }),
    ]);
    api.on('POST /facility-bookings/a/confirm', booking({ id: 'a', status: 'confirmed' }));
    api.on('POST /facility-bookings/b/start', booking({ id: 'b', status: 'active' }));
    api.on('POST /facility-bookings/b/no-show', booking({ id: 'b', status: 'no_show' }));
    api.on('POST /facility-bookings/c/complete', booking({ id: 'c', status: 'completed' }));

    await user.click(await (await column('Requested')).findByRole('button', { name: 'Confirm' }));
    const confirmed = await column('Confirmed');
    await user.click(await confirmed.findByRole('button', { name: 'Start session' }));
    await user.click(confirmed.getByRole('button', { name: 'Mark no-show' }));
    await user.click(
      await (await column('In progress')).findByRole('button', { name: 'Finish session' }),
    );

    await waitFor(() => {
      const posts = api.calls.filter((c) => c.method === 'POST').map((c) => c.path);
      expect(posts).toEqual([
        '/facility-bookings/a/confirm',
        '/facility-bookings/b/start',
        '/facility-bookings/b/no-show',
        '/facility-bookings/c/complete',
      ]);
    });
  });

  it('lets the front desk cancel a booking but not run the session', async () => {
    open('front_desk', [
      booking({ id: 'a', code: 'FB-AAAAAA', status: 'requested' }),
      booking({ id: 'b', code: 'FB-BBBBBB', status: 'confirmed' }),
      booking({ id: 'c', code: 'FB-CCCCCC', status: 'active' }),
    ]);
    await screen.findByText('FB-AAAAAA');
    for (const name of ['Confirm', 'Start session', 'Mark no-show', 'Finish session']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // Requested and confirmed can be cancelled; an active session cannot.
    expect(screen.getAllByRole('button', { name: 'Cancel booking' })).toHaveLength(2);
  });

  it('needs a reason to cancel, and sends it', async () => {
    const user = userEvent.setup();
    const { api } = open('front_desk', [booking()]);
    api.on('POST /facility-bookings/b1/cancel', booking({ status: 'cancelled' }));

    await user.click(await screen.findByRole('button', { name: 'Cancel booking' }));
    const confirm = await screen.findByRole('button', { name: 'Cancel this booking' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Why is it being cancelled?'), 'Guest unwell');
    await user.click(confirm);

    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/facility-bookings/b1/cancel')?.body).toEqual({
        reason: 'Guest unwell',
      }),
    );
  });

  it('shows the server’s reason when an action is refused', async () => {
    const user = userEvent.setup();
    const { api } = open('spa_recreation', [booking({ status: 'confirmed' })]);
    api.on('POST /facility-bookings/b1/no-show', () => {
      throw new ApiError(
        409,
        'too_early',
        'The slot has not started yet, so this cannot be a no-show',
      );
    });
    await user.click(await screen.findByRole('button', { name: 'Mark no-show' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The slot has not started yet');
  });

  it('shows another day when the date changes, and one facility when it is picked', async () => {
    const user = userEvent.setup();
    const { queries } = open('spa_recreation', [
      booking(),
      booking({ id: 'b2', facilityId: 'f2', facilityName: 'Rooftop Pool', code: 'FB-POOLPO' }),
    ]);
    await screen.findByText('FB-7H3K9Q');

    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-12-05' } });
    await waitFor(() => expect(queries.some((q) => q.date === '2026-12-05')).toBe(true));

    await user.selectOptions(screen.getByLabelText('Facility'), 'f2');
    await waitFor(() => expect(queries.some((q) => q.facilityId === 'f2')).toBe(true));
    await waitFor(() => expect(screen.queryByText('FB-7H3K9Q')).not.toBeInTheDocument());
    expect(screen.getByText('FB-POOLPO')).toBeInTheDocument();
  });
});

describe('booking a facility from the screen', () => {
  const slots = [
    {
      startTime: '08:00',
      endTime: '09:00',
      capacity: 1,
      booked: 0,
      remaining: 1,
      past: true,
      bookable: false,
    },
    {
      startTime: '09:00',
      endTime: '10:00',
      capacity: 1,
      booked: 1,
      remaining: 0,
      past: false,
      bookable: false,
    },
    {
      startTime: '10:00',
      endTime: '11:00',
      capacity: 1,
      booked: 0,
      remaining: 1,
      past: false,
      bookable: true,
    },
  ];

  function openDesk() {
    const { api } = open('front_desk', []);
    api.on('GET /facilities/f1/slots', slots);
    api.on('GET /facilities/f2/slots', []);
    return api;
  }

  it('offers only rooms with a guest, and only slots that can still be booked', async () => {
    const user = userEvent.setup();
    openDesk();
    await user.click(await screen.findByRole('button', { name: 'New booking' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book a facility' });
    const room = within(dialog).getByLabelText('Room');
    expect(within(room).getByRole('option', { name: 'Room 204' })).toBeInTheDocument();
    expect(within(room).queryByRole('option', { name: 'Room 205' })).not.toBeInTheDocument();

    expect(await within(dialog).findByRole('button', { name: /10:00–11:00/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /09:00–10:00/ })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /08:00–09:00/ })).toBeDisabled();
    expect(within(dialog).getByText('Full')).toBeInTheDocument();
    expect(within(dialog).getByText('Started')).toBeInTheDocument();
  });

  it('keeps Book disabled until a slot is chosen', async () => {
    const user = userEvent.setup();
    openDesk();
    await user.click(await screen.findByRole('button', { name: 'New booking' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book a facility' });
    const book = within(dialog).getByRole('button', { name: 'Book' });
    expect(book).toBeDisabled();
    await user.click(await within(dialog).findByRole('button', { name: /10:00–11:00/ }));
    expect(book).toBeEnabled();
  });

  it('sends only ids, the date, the time and the number of people, and shows the server’s price', async () => {
    const user = userEvent.setup();
    const api = openDesk();
    api.on('POST /facility-bookings', booking({ id: 'new', totalPaise: 300_000 }));

    await user.click(await screen.findByRole('button', { name: 'New booking' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book a facility' });
    await user.click(await within(dialog).findByRole('button', { name: /10:00–11:00/ }));
    await user.clear(within(dialog).getByLabelText('People'));
    await user.type(within(dialog).getByLabelText('People'), '1');
    await user.type(within(dialog).getByLabelText('Notes (optional)'), 'Birthday');
    const date = (within(dialog).getByLabelText('Date') as HTMLInputElement).value;
    await user.click(within(dialog).getByRole('button', { name: 'Book' }));

    await waitFor(() =>
      expect(
        api.calls.find((c) => c.method === 'POST' && c.path === '/facility-bookings')?.body,
      ).toEqual({
        facilityId: 'f1',
        roomId: 'r1',
        date,
        startTime: '10:00',
        participants: 1,
        notes: 'Birthday',
      }),
    );
    expect(
      await screen.findByText('Booked Ayurvedic Spa for Room 204 · ₹3,000.00'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the reason in the dialog when the server refuses the booking', async () => {
    const user = userEvent.setup();
    const api = openDesk();
    api.on('POST /facility-bookings', () => {
      throw new ApiError(409, 'slot_full', 'That slot is full. Please pick another time.');
    });
    await user.click(await screen.findByRole('button', { name: 'New booking' }));
    const dialog = await screen.findByRole('dialog', { name: 'Book a facility' });
    await user.click(await within(dialog).findByRole('button', { name: /10:00–11:00/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Book' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That slot is full');
    expect(screen.getByRole('dialog', { name: 'Book a facility' })).toBeInTheDocument();
  });
});
