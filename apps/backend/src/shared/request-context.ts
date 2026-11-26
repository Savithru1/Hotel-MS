import { AsyncLocalStorage } from 'node:async_hooks';
import type { Types } from 'mongoose';

export interface Principal {
  kind: 'staff' | 'guest' | 'system';
  id: string;
  role?: string;
}

/**
 * Per-request state, carried through every await without being passed around.
 *
 * - `propertyId` is the tenant. It is only ever set from a verified token, never from client input.
 * - `platform` marks code that is deliberately allowed to see every tenant (seeding, jobs).
 */
export interface RequestContext {
  requestId?: string;
  ip?: string;
  propertyId?: Types.ObjectId;
  platform?: boolean;
  principal?: Principal;
}

const storage = new AsyncLocalStorage<RequestContext>();

function isLazyThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Promise) &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Runs `fn` with its own copy of the context. The copy is what `bindPrincipal` later fills in.
 *
 * Mongoose queries are lazy: they only run when awaited. If `fn` returns an unexecuted query
 * (for example `runWithTenant(id, () => Model.find())`) it would run after the context has
 * ended and be refused or, worse, be unscoped. So a returned lazy thenable is started here,
 * inside the context.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run({ ...context }, () => {
    const result = fn();
    if (isLazyThenable(result)) {
      return new Promise((resolve, reject) => {
        result.then(resolve, reject);
      }) as T;
    }
    return result;
  });
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getTenantId(): Types.ObjectId | undefined {
  return storage.getStore()?.propertyId;
}

/** Runs `fn` as the given property. Everything underneath is restricted to that property. */
export function runWithTenant<T>(propertyId: Types.ObjectId, fn: () => T): T {
  const next: RequestContext = { ...getContext(), propertyId };
  delete next.platform;
  return runWithContext(next, fn);
}

/** Runs `fn` as the given property with `principal` recorded as the actor (for audit entries). */
export function runWithPrincipal<T>(
  principal: Principal,
  propertyId: Types.ObjectId,
  fn: () => T,
): T {
  const next: RequestContext = { ...getContext(), propertyId, principal };
  delete next.platform;
  return runWithContext(next, fn);
}

/**
 * Runs `fn` with access to every property. Use only for seeding, background jobs and similar
 * code that is not acting for one property. Searching the code base for this name lists every
 * place that bypasses tenant scoping.
 */
export function runAsPlatform<T>(fn: () => T): T {
  const next: RequestContext = { ...getContext(), platform: true };
  delete next.propertyId;
  return runWithContext(next, fn);
}

/** Called once by authentication, after the token is verified, to attach who is calling. */
export function bindPrincipal(principal: Principal, propertyId: Types.ObjectId): void {
  const context = storage.getStore();
  if (!context) {
    throw new Error('There is no request context to bind the principal to');
  }
  context.principal = principal;
  context.propertyId = propertyId;
}
