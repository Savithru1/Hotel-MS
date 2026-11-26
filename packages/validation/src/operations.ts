import {
  HOUSEKEEPING_STATUSES,
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUSES,
  REQUEST_PRIORITIES,
  SERVICE_REQUEST_TYPES,
} from '@hospitality/constants';
import { z } from 'zod';
import { objectIdSchema, paginationSchema } from './common';

const notes = z.string().trim().max(500);
const reason = z.string().trim().min(3, 'please give a reason').max(200);
const booleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

// Housekeeping ---------------------------------------------------------------------------

export const createHousekeepingRequestSchema = z.object({
  roomId: objectIdSchema,
  type: z.enum(SERVICE_REQUEST_TYPES),
  notes: notes.default(''),
  priority: z.enum(REQUEST_PRIORITIES).default('normal'),
});

export const listHousekeepingQuerySchema = paginationSchema.extend({
  status: z.enum(HOUSEKEEPING_STATUSES).optional(),
  roomId: objectIdSchema.optional(),
  /** Only requests assigned to me. */
  mine: booleanQuery,
  escalated: booleanQuery,
  /** `open` = new or in progress. */
  open: booleanQuery,
});

export const assignSchema = z.object({ staffId: objectIdSchema });
export const escalateSchema = z.object({ reason });
export const completeSchema = z.object({ note: z.string().trim().max(200).optional() });

// Maintenance ----------------------------------------------------------------------------

export const createMaintenanceIssueSchema = z.object({
  roomId: objectIdSchema,
  category: z.enum(MAINTENANCE_CATEGORIES),
  description: z.string().trim().min(3, 'please describe the problem').max(500),
  priority: z.enum(MAINTENANCE_PRIORITIES).default('medium'),
  /** Take the room out of service until this is resolved. Not possible while a guest is in it. */
  takeRoomOutOfService: z.boolean().default(false),
});

export const listMaintenanceQuerySchema = paginationSchema.extend({
  status: z.enum(MAINTENANCE_STATUSES).optional(),
  roomId: objectIdSchema.optional(),
  priority: z.enum(MAINTENANCE_PRIORITIES).optional(),
  mine: booleanQuery,
  escalated: booleanQuery,
  open: booleanQuery,
});

export const resolveMaintenanceSchema = z.object({
  resolutionNote: z.string().trim().min(3, 'please say what was done').max(300),
});
