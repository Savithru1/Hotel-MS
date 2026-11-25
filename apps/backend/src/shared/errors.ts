/**
 * An error that is safe to show to the client. Anything that is not an HttpError is treated as
 * an unexpected failure: it is logged in full and the client only sees a generic message.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown): HttpError =>
  new HttpError(400, code, message, details);

export const unauthorized = (
  message = 'Authentication required',
  code = 'unauthorized',
): HttpError => new HttpError(401, code, message);

export const forbidden = (
  message = 'You do not have access to this',
  code = 'forbidden',
): HttpError => new HttpError(403, code, message);

export const notFound = (message = 'Not found', code = 'not_found'): HttpError =>
  new HttpError(404, code, message);

export const conflict = (message: string, code = 'conflict', details?: unknown): HttpError =>
  new HttpError(409, code, message, details);
