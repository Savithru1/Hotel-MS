import { GUEST_ID_TYPES } from '@hospitality/constants';
import { z } from 'zod';
import { emailSchema, paginationSchema, shortText } from './common';
import { gstinSchema } from './property';
import { phoneSchema } from './phone';

const idDetailsSchema = z.object({
  idType: z.enum(GUEST_ID_TYPES),
  idNumber: z.string().trim().min(4).max(30),
});

export const createGuestSchema = z.object({
  name: shortText(100),
  phone: phoneSchema,
  email: emailSchema.optional(),
  gstin: gstinSchema.optional(),
  idDetails: idDetailsSchema.optional(),
});

export const updateGuestSchema = z
  .object({
    name: shortText(100).optional(),
    phone: phoneSchema.optional(),
    email: emailSchema.nullable().optional(),
    gstin: gstinSchema.nullable().optional(),
    idDetails: idDetailsSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to change' });

export const searchGuestsQuerySchema = paginationSchema.extend({
  /** A name, part of a phone number, or part of an email. */
  q: z.string().trim().min(2).max(60).optional(),
});
