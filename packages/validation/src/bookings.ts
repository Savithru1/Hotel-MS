import { BOOKING_STATUSES, MAX_STAY_NIGHTS } from '@hospitality/constants';
import { z } from 'zod';
import { emailSchema, objectIdSchema, paginationSchema, shortText } from './common';
import { phoneSchema } from './phone';
import { dateOnlySchema } from './property';

const stayDates = (value: { checkInDate: string; checkOutDate: string }, context: z.RefinementCtx) => {
  const nights = (Date.parse(value.checkOutDate) - Date.parse(value.checkInDate)) / 86_400_000;
  if (!(nights >= 1)) {
    context.addIssue({
      code: 'custom',
      path: ['checkOutDate'],
      message: 'must be after the check-in date',
    });
  } else if (nights > MAX_STAY_NIGHTS) {
    context.addIssue({
      code: 'custom',
      path: ['checkOutDate'],
      message: `a stay can be at most ${MAX_STAY_NIGHTS} nights`,
    });
  }
};

const notesSchema = z.string().trim().max(500);

export const newGuestSchema = z.object({
  name: shortText(100),
  phone: phoneSchema,
  email: emailSchema.optional(),
});

export const createBookingSchema = z
  .object({
    /** An existing guest profile... */
    guestId: objectIdSchema.optional(),
    /** ...or the details to find or create one by phone number. */
    guest: newGuestSchema.optional(),
    roomTypeId: objectIdSchema,
    /** A specific room. When left out, the system picks a free room of the type. */
    roomId: objectIdSchema.optional(),
    checkInDate: dateOnlySchema,
    checkOutDate: dateOnlySchema,
    adults: z.number().int().min(1).max(20).default(1),
    children: z.number().int().min(0).max(20).default(0),
    notes: notesSchema.default(''),
    status: z.enum(['pending', 'confirmed']).default('confirmed'),
  })
  .superRefine((value, context) => {
    if (Boolean(value.guestId) === Boolean(value.guest)) {
      context.addIssue({
        code: 'custom',
        path: ['guest'],
        message: 'give either guestId or guest details, not both and not neither',
      });
    }
    stayDates(value, context);
  });

export const updateBookingSchema = z
  .object({
    checkInDate: dateOnlySchema.optional(),
    checkOutDate: dateOnlySchema.optional(),
    roomId: objectIdSchema.optional(),
    adults: z.number().int().min(1).max(20).optional(),
    children: z.number().int().min(0).max(20).optional(),
    notes: notesSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to change' });

export const cancelBookingSchema = z.object({
  reason: z.string().trim().min(3, 'please give a reason').max(200),
});

export const checkInBookingSchema = z.object({
  /** Check the guest into a different room than the one booked. */
  roomId: objectIdSchema.optional(),
  note: z.string().trim().max(200).optional(),
});

export const availabilityQuerySchema = z
  .object({
    checkInDate: dateOnlySchema,
    checkOutDate: dateOnlySchema,
    roomTypeId: objectIdSchema.optional(),
  })
  .superRefine(stayDates);

export const listBookingsQuerySchema = paginationSchema.extend({
  status: z.enum(BOOKING_STATUSES).optional(),
  /** Bookings whose stay overlaps this window. */
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  roomId: objectIdSchema.optional(),
  /** A booking code, a guest name or a phone number. */
  q: z.string().trim().min(2).max(60).optional(),
});

export const calendarQuerySchema = z
  .object({ from: dateOnlySchema, to: dateOnlySchema })
  .superRefine((value, context) => {
    const days = (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000;
    if (!(days >= 0) || days > 62) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'must be within 62 days of from' });
    }
  });
