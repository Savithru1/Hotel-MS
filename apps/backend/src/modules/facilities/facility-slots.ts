import { toMinutes } from '@hospitality/validation';

export interface SlotTimes {
  startTime: string;
  endTime: string;
}

export interface SlotSchedule {
  opensAt: string;
  closesAt: string;
  slotMinutes: number;
}

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * The slots of one day: end to end from opening time, each `slotMinutes` long. A last slot that
 * would run past closing time is left out, so a booking never overruns the opening hours.
 */
export function buildSlots(opensAt: string, closesAt: string, slotMinutes: number): SlotTimes[] {
  const slots: SlotTimes[] = [];
  const close = toMinutes(closesAt);
  for (let start = toMinutes(opensAt); start + slotMinutes <= close; start += slotMinutes) {
    slots.push({ startTime: clock(start), endTime: clock(start + slotMinutes) });
  }
  return slots;
}

/** The slot that starts exactly at `startTime`, or null when no slot starts then. */
export function findSlot(schedule: SlotSchedule, startTime: string): SlotTimes | null {
  return (
    buildSlots(schedule.opensAt, schedule.closesAt, schedule.slotMinutes).find(
      (slot) => slot.startTime === startTime,
    ) ?? null
  );
}
