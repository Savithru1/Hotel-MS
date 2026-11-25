import type { ClientSession, Types } from 'mongoose';
import { getContext, type Principal } from '../request-context';
import { TenantContextError, TenantMismatchError } from '../tenant-plugin';
import { AuditLog } from './audit-log.model';

export interface AuditInput {
  /** Dotted action name, for example `staff.role_changed` or `booking.checked_out`. */
  action: string;
  target: { type: string; id: string };
  /** Small, non-sensitive description of the change (before/after values, reasons). */
  summary?: Record<string, unknown>;
  /** Only for platform code, which has no tenant of its own. */
  propertyId?: Types.ObjectId;
  /** Pass the session of a surrounding transaction so the entry commits or rolls back with it. */
  session?: ClientSession;
}

const SYSTEM_ACTOR: Principal = { kind: 'system', id: 'system' };

/**
 * Appends one entry to the audit log. Who did it, from where and during which request come
 * from the request context, so callers cannot forget or fake them.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  const context = getContext();

  let propertyId: Types.ObjectId | undefined;
  if (context?.propertyId) {
    if (input.propertyId && !input.propertyId.equals(context.propertyId)) {
      throw new TenantMismatchError('recordAudit');
    }
    propertyId = context.propertyId;
  } else if (context?.platform) {
    propertyId = input.propertyId;
    if (!propertyId) {
      throw new Error('recordAudit needs an explicit propertyId when running as the platform.');
    }
  } else {
    throw new TenantContextError('recordAudit');
  }

  await AuditLog.create(
    [
      {
        propertyId,
        actor: context.principal ?? SYSTEM_ACTOR,
        action: input.action,
        target: input.target,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(context.requestId ? { requestId: context.requestId } : {}),
        ...(context.ip ? { ip: context.ip } : {}),
      },
    ],
    { session: input.session ?? null },
  );
}
