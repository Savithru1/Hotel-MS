/**
 * Types shared by the backend and both frontends. Every API response uses one of these envelopes.
 */

export interface PageMeta {
  total: number;
  page: number;
  limit: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PageMeta;
}

export interface ApiErrorBody {
  /** Stable, machine-readable code, for example `validation_error` or `bad_transition`. */
  code: string;
  /** Safe, human-readable message. Never contains secrets or submitted values. */
  message: string;
  details?: unknown;
}

export interface ApiFailure {
  success: false;
  error: ApiErrorBody;
  requestId?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export * from './auth';
export * from './property';
export * from './booking';
export * from './operations';
export * from './food';
export * from './facilities';
export * from './billing';
export * from './manager';
