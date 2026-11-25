declare global {
  namespace Express {
    interface Request {
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
