/**
 * The audit summary is free-form, written by many modules. Before it is shown to anyone, anything
 * that looks like a password, hash, token, one-time code or ID document number is replaced, so a
 * mistake in one module can never leak a secret through the audit screen.
 */

export const REDACTED = '[redacted]';

const SENSITIVE_KEY = new RegExp(
  [
    'pass(word|code|phrase)?',
    'hash',
    'token',
    'secret',
    'credential',
    'api_?key',
    'authori[sz]ation',
    'cookie',
    'cvv',
    'card_?number',
    'id_?number',
    'id_?details',
    'document_?number',
    'aadhaar',
    'aadhar',
    'passport',
    'licen[cs]e_?number',
    'pan_?number',
  ].join('|'),
  'i',
);
/** `otp` as a word of its own, so `footprint` is not caught. */
const OTP_KEY = /(^|[^A-Za-z])[oO][tT][pP]($|[^a-z])/;

/** A bcrypt hash, and a signed token with three dot-separated parts. */
const SECRET_VALUE = [/^\$2[aby]\$\d{2}\$\S{20,}$/, /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/];

const MAX_DEPTH = 8;
const MAX_TEXT_CHARS = 500;
const MAX_ITEMS = 100;

const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key) || OTP_KEY.test(key);

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    if (SECRET_VALUE.some((pattern) => pattern.test(value))) return REDACTED;
    return value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS)}…` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => redactValue(item, depth + 1));
  }
  return redactObject(value as Record<string, unknown>, depth + 1);
}

function redactObject(source: Record<string, unknown>, depth: number): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source)
      .slice(0, MAX_ITEMS)
      .map(([key, value]) => [key, isSensitiveKey(key) ? REDACTED : redactValue(value, depth)]),
  );
}

/** A copy of the summary that is safe to show, or null when there is nothing to show. */
export function redactSummary(summary: unknown): Record<string, unknown> | null {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return null;
  return redactObject(summary as Record<string, unknown>, 0);
}
