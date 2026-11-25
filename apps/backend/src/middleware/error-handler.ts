import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { HttpError, notFound } from '../shared/errors';

interface Issue {
  path: string;
  message: string;
}

/** Plain-language text for mongoose validator kinds. Never repeats the submitted value. */
const VALIDATOR_MESSAGES: Record<string, string> = {
  required: 'is required',
  enum: 'is not an allowed value',
  minlength: 'is too short',
  maxlength: 'is too long',
  min: 'is too small',
  max: 'is too large',
  unique: 'is already in use',
};

const validationError = (issues: Issue[]): HttpError =>
  new HttpError(400, 'validation_error', 'Request validation failed', { issues });

interface ErrorLike {
  code?: unknown;
  type?: unknown;
  status?: unknown;
  expose?: unknown;
  keyPattern?: unknown;
  message?: unknown;
}

/** Turns a known, safe-to-show failure into an HttpError, or returns undefined if unknown. */
function toHttpError(error: unknown): HttpError | undefined {
  if (error instanceof HttpError) return error;

  if (error instanceof ZodError) {
    return validationError(
      error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  if (error instanceof mongoose.Error.ValidationError) {
    return validationError(
      Object.entries(error.errors).map(([path, problem]) => ({
        path,
        message: VALIDATOR_MESSAGES[(problem as { kind?: string }).kind ?? ''] ?? 'is invalid',
      })),
    );
  }

  if (error instanceof mongoose.Error.CastError) {
    const isId = error.path === '_id' || error.path.endsWith('Id');
    return new HttpError(
      400,
      isId ? 'invalid_id' : 'invalid_value',
      `Invalid value for ${error.path}`,
    );
  }

  const like = error as ErrorLike;

  if (like.code === 11000) {
    const fields =
      like.keyPattern && typeof like.keyPattern === 'object' ? Object.keys(like.keyPattern) : [];
    return new HttpError(409, 'duplicate', 'That value is already in use', { fields });
  }

  if (like.type === 'entity.parse.failed') {
    return new HttpError(400, 'bad_json', 'Request body is not valid JSON');
  }
  if (like.type === 'entity.too.large') {
    return new HttpError(413, 'payload_too_large', 'Request body is too large');
  }
  if (
    typeof like.status === 'number' &&
    like.status >= 400 &&
    like.status < 500 &&
    like.expose === true &&
    typeof like.message === 'string'
  ) {
    return new HttpError(like.status, 'bad_request', like.message);
  }

  return undefined;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound('Route not found'));
};

/**
 * The single place where errors become responses. Known errors keep their status and code;
 * anything else is logged in full and the client only sees a generic message.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const requestId = res.getHeader('x-request-id');
    const known = toHttpError(error);

    if (!known || known.status >= 500) {
      logger.error(
        { err: error, requestId, method: req.method, url: req.originalUrl },
        'Request failed',
      );
    }

    const httpError = known ?? new HttpError(500, 'server_error', 'Something went wrong');
    // Server errors never expose details, even from an HttpError.
    const details = httpError.status >= 500 ? undefined : httpError.details;

    res.status(httpError.status).json({
      success: false,
      error: {
        code: httpError.code,
        message: httpError.message,
        ...(details === undefined ? {} : { details }),
      },
      requestId,
    });
  };
}
