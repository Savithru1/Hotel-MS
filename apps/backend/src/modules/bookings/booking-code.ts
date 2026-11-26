import { generateReadableCode } from '../../shared/readable-code';

/**
 * A readable, hard-to-guess booking code like `BK-7H3K9Q`. It is also half of the guest's login
 * later, so it must not be predictable.
 */
export function generateBookingCode(): string {
  return generateReadableCode('BK');
}
