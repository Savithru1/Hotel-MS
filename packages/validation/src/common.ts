import { z } from 'zod';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** A MongoDB ObjectId in its 24-character hex form. */
export const objectIdSchema = z.string().regex(OBJECT_ID, 'must be a valid id');

export const MAX_PAGE_SIZE = 100;

/** `?page=1&limit=25`. Every list endpoint takes this, and the limit is always capped. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
});

export type Pagination = z.output<typeof paginationSchema>;

/** Trimmed, non-empty text with a length cap. */
export const shortText = (max = 120): z.ZodString => z.string().trim().min(1).max(max);

/** An email address, trimmed and lower-cased so the same address always compares equal. */
export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
