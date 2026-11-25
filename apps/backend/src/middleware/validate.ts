import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { HttpError } from '../shared/errors';

export interface ValidationSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

const PARTS = ['params', 'query', 'body'] as const;

/**
 * Validates the request against Zod schemas and puts the parsed result on `req.validated`.
 * Fields the schema does not list are removed, so a client cannot smuggle in extra data such as
 * `role` or `propertyId`. Handlers must read `req.validated`, never the raw `req.body`.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const issues: { path: string; message: string }[] = [];
    const validated: NonNullable<typeof req.validated> = {};

    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ path: [part, ...issue.path].join('.'), message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      throw new HttpError(400, 'validation_error', 'Request validation failed', { issues });
    }

    req.validated = validated;
    next();
  };
}
