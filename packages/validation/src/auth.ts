import { z } from 'zod';
import { emailSchema } from './common';

/**
 * bcrypt only reads the first 72 bytes, so a longer password would be silently cut. Passwords
 * are therefore limited to 72 bytes, and the check counts bytes, not characters.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_BYTES = 72;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine((value) => new TextEncoder().encode(value).length <= PASSWORD_MAX_BYTES, {
    message: `must be at most ${PASSWORD_MAX_BYTES} bytes`,
  })
  .refine((value) => /[A-Za-z]/.test(value) && /[0-9]/.test(value), {
    message: 'must contain at least one letter and one number',
  });

export const propertySlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a valid property link name')
  .max(60);

export const staffLoginSchema = z.object({
  propertySlug: propertySlugSchema,
  email: emailSchema,
  // Not checked for strength here: this is whatever the person typed, compared with the stored hash.
  password: z.string().min(1).max(200),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export type StaffLoginInput = z.output<typeof staffLoginSchema>;
