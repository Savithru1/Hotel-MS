import { MANUAL_ROOM_STATUSES, MAX_ROOM_RATE_PAISE } from '@hospitality/constants';
import { z } from 'zod';
import { objectIdSchema, paginationSchema, shortText } from './common';

export const ratePaiseSchema = z
  .number({ error: 'must be a whole number of paise' })
  .int('must be a whole number of paise')
  .min(0, 'cannot be negative')
  .max(MAX_ROOM_RATE_PAISE, 'is higher than any realistic room rate');

const amenitiesSchema = z
  .array(shortText(40))
  .max(30)
  .transform((values) => [...new Set(values)]);

export const createRoomTypeSchema = z.object({
  name: shortText(60),
  capacity: z.number().int().min(1).max(20),
  ratePaise: ratePaiseSchema,
  amenities: amenitiesSchema.default([]),
});

export const updateRoomTypeSchema = z
  .object({
    name: shortText(60).optional(),
    capacity: z.number().int().min(1).max(20).optional(),
    ratePaise: ratePaiseSchema.optional(),
    amenities: amenitiesSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to change' });

/** Room numbers are labels (`204`, `B-12`), not numbers, so they keep their exact text. */
export const roomNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(10)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, 'may only contain letters, digits, spaces and dashes');

export const createRoomSchema = z.object({
  number: roomNumberSchema,
  floor: z.number().int().min(-5).max(200),
  roomTypeId: objectIdSchema,
});

export const updateRoomSchema = z
  .object({
    number: roomNumberSchema.optional(),
    floor: z.number().int().min(-5).max(200).optional(),
    roomTypeId: objectIdSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to change' });

export const setRoomStatusSchema = z.object({
  status: z.enum(MANUAL_ROOM_STATUSES),
  note: z.string().trim().max(200).optional(),
});

export const listRoomsQuerySchema = paginationSchema.extend({
  floor: z.coerce.number().int().optional(),
  roomTypeId: objectIdSchema.optional(),
  status: z
    .enum(['available', 'occupied', 'reserved', 'cleaning', 'maintenance', 'out_of_service'])
    .optional(),
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export const idParamsSchema = z.object({ id: objectIdSchema });
