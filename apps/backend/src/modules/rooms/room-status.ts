import { ROOM_STATUSES, ROOM_STATUS_TRANSITIONS, type RoomStatus } from '@hospitality/constants';
import { defineStateMachine } from '../../shared/state-machine';

/**
 * The room status workflow. Status is never edited freely: every change goes through
 * `transition()`, which enforces this table and records the move in `history`.
 */
export const roomStatusMachine = defineStateMachine<RoomStatus>({
  name: 'room',
  initial: 'available',
  transitions: Object.fromEntries(
    ROOM_STATUSES.map((status) => [status, ROOM_STATUS_TRANSITIONS[status]]),
  ) as Record<RoomStatus, readonly RoomStatus[]>,
});
