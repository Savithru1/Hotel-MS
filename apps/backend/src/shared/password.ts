import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';

export function hashPassword(password: string, cost: number): Promise<string> {
  return bcrypt.hash(password, cost);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Letters and digits without look-alikes (0/O, 1/l/I), so a password read out over the phone or
// off a printed slip is not misread.
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const TEMPORARY_PASSWORD_LENGTH = 14;

const pick = (alphabet: string): string => alphabet[randomInt(alphabet.length)] as string;

/**
 * A random one-time password from a cryptographic generator. It always has a letter and a
 * digit so it passes the password rules, and the person must change it at first sign-in.
 */
export function generateTemporaryPassword(): string {
  const all = LETTERS + DIGITS;
  const characters = [pick(LETTERS), pick(DIGITS)];
  while (characters.length < TEMPORARY_PASSWORD_LENGTH) characters.push(pick(all));
  // Fisher-Yates shuffle so the guaranteed characters are not always first.
  for (let i = characters.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [characters[i], characters[j]] = [characters[j] as string, characters[i] as string];
  }
  return characters.join('');
}
