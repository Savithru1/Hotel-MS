import {
  FACILITY_BOOKING_STATUSES,
  FACILITY_TYPES,
  MAX_FACILITY_CAPACITY,
  MAX_FACILITY_PRICE_PAISE,
  MAX_SLOT_MINUTES,
  MIN_SLOT_MINUTES,
} from '@hospitality/constants';
import { z } from 'zod';
import { objectIdSchema, paginationSchema, shortText } from './common';
import { dateOnlySchema, timeOfDaySchema } from './property';

const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

/** Minutes since midnight for an `HH:mm` time of day. */
export const toMinutes = (time: string): number =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

const slotMinutes = z
  .number()
  .int()
  .min(MIN_SLOT_MINUTES)
  .max(MAX_SLOT_MINUTES)
  .refine((value) => value % 5 === 0, 'must be a multiple of 5 minutes');
const capacity = z.number().int().min(1).max(MAX_FACILITY_CAPACITY);
const pricePaise = z.number().int().min(0).max(MAX_FACILITY_PRICE_PAISE);
const participants = z.number().int().min(1).max(MAX_FACILITY_CAPACITY);

// Facilities -----------------------------------------------------------------------------

export const createFacilitySchema = z
  .object({
    name: shortText(80),
    type: z.enum(FACILITY_TYPES),
    description: z.string().trim().max(300).default(''),
    /** How many people one slot takes. 1 means the facility is used by one booking at a time. */
    capacity,
    slotMinutes,
    opensAt: timeOfDaySchema,
    closesAt: timeOfDaySchema,
    /** Per person, per slot, before tax. Free facilities use 0. */
    pricePaise,
    active: z.boolean().default(true),
  })
  .superRefine((facility, context) => {
    const span = toMinutes(facility.closesAt) - toMinutes(facility.opensAt);
    if (span <= 0) {
      context.addIssue({
        code: 'custom',
        message: 'must be after the opening time',
        path: ['closesAt'],
      });
    } else if (span < facility.slotMinutes) {
      context.addIssue({
        code: 'custom',
        message: 'is too short for even one slot',
        path: ['closesAt'],
      });
    }
  });

/** Written out field by field so a partial change never brings the create defaults along. */
export const updateFacilitySchema = z
  .object({
    name: shortText(80).optional(),
    type: z.enum(FACILITY_TYPES).optional(),
    description: z.string().trim().max(300).optional(),
    capacity: capacity.optional(),
    slotMinutes: slotMinutes.optional(),
    opensAt: timeOfDaySchema.optional(),
    closesAt: timeOfDaySchema.optional(),
    pricePaise: pricePaise.optional(),
    active: z.boolean().optional(),
  })
  .refine((change) => Object.values(change).some((value) => value !== undefined), {
    message: 'send at least one field to change',
  });

export const listFacilitiesQuerySchema = paginationSchema.extend({
  type: z.enum(FACILITY_TYPES).optional(),
  active: booleanQuery,
});

export const slotsQuerySchema = z.object({ date: dateOnlySchema });

// Facility bookings ----------------------------------------------------------------------

/** There is deliberately no price, status or booking id here: the server works them out. */
export const createFacilityBookingSchema = z.object({
  facilityId: objectIdSchema,
  /** The room of the checked-in guest the booking is for. */
  roomId: objectIdSchema,
  date: dateOnlySchema,
  startTime: timeOfDaySchema,
  participants: participants.default(1),
  notes: z.string().trim().max(300).default(''),
});

export const listFacilityBookingsQuerySchema = paginationSchema.extend({
  date: dateOnlySchema.optional(),
  facilityId: objectIdSchema.optional(),
  roomId: objectIdSchema.optional(),
  bookingId: objectIdSchema.optional(),
  status: z.enum(FACILITY_BOOKING_STATUSES).optional(),
  /** `open` = requested, confirmed or active. */
  open: booleanQuery,
});

export const facilityBookingSummaryQuerySchema = z.object({ date: dateOnlySchema });

export const cancelFacilityBookingSchema = z.object({
  reason: z.string().trim().min(3, 'please give a reason').max(200),
});
