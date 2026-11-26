import type { AuthenticatedStaff } from '../modules/auth/auth.types';

declare global {
  namespace Express {
    interface Request {
      /** Set by `authenticate`. Never taken from the request body. */
      staff?: AuthenticatedStaff;
      /** Parsed request data, set by the `validate` middleware. Unknown fields are removed. */
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
