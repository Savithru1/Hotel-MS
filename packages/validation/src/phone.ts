import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';

/** Numbers typed without a country code are read as Indian numbers. */
export const DEFAULT_PHONE_REGION = 'IN';

/**
 * Turns whatever a person typed (`98765 43210`, `+91-98765-43210`, `09876543210`) into E.164
 * (`+919876543210`), or returns null if it is not a real, valid number. Guest phone numbers are
 * always stored and compared in this one form.
 */
export function normalizePhone(input: string): string | null {
  const text = input.trim();
  if (text.length === 0 || text.length > 30) return null;
  const parsed = parsePhoneNumberFromString(text, DEFAULT_PHONE_REGION);
  if (!parsed?.isValid()) return null;
  return parsed.number;
}

export const phoneSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      context.addIssue({ code: 'custom', message: 'must be a valid phone number' });
      return z.NEVER;
    }
    return normalized;
  });
