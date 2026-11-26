import { BOOKING_STATUSES, BOOKING_TRANSITIONS, type BookingStatus } from '@hospitality/constants';
import { defineStateMachine } from '../../shared/state-machine';

/** The booking workflow. Every status change goes through `transition()` and this table. */
export const bookingStatusMachine = defineStateMachine<BookingStatus>({
  name: 'booking',
  initial: 'confirmed',
  transitions: Object.fromEntries(
    BOOKING_STATUSES.map((status) => [status, BOOKING_TRANSITIONS[status]]),
  ) as Record<BookingStatus, readonly BookingStatus[]>,
});
