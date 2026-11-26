import { ASSIGNABLE_ROLES, DEPARTMENTS } from '@hospitality/constants';
import { z } from 'zod';
import { emailSchema, objectIdSchema, paginationSchema, shortText } from './common';

const roleSchema = z.enum(ASSIGNABLE_ROLES as [string, ...string[]]);
const departmentsSchema = z
  .array(z.enum(DEPARTMENTS))
  .min(1)
  .max(DEPARTMENTS.length)
  .transform((values) => [...new Set(values)]);

export const createStaffSchema = z.object({
  name: shortText(100),
  email: emailSchema,
  role: roleSchema,
  departments: departmentsSchema.optional(),
});

export const updateStaffSchema = z
  .object({
    name: shortText(100).optional(),
    role: roleSchema.optional(),
    departments: departmentsSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to change' });

export const staffIdParamsSchema = z.object({ id: objectIdSchema });

export const listStaffQuerySchema = paginationSchema.extend({
  role: roleSchema.optional(),
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
