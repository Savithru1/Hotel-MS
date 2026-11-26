import { randomInt } from 'node:crypto';

// No 0/O, 1/I/L, so a code read out over the phone or printed on a slip is not misread.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/**
 * A readable, hard-to-guess code such as `BK-7H3K9Q` or `FO-4M2XQP`. About 887 million
 * combinations from a cryptographic generator, so codes cannot be enumerated to find other
 * guests' bookings or orders.
 */
export function generateReadableCode(prefix: string): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${code}`;
}
