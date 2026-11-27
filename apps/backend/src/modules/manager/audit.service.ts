import type { AuditEntryDto } from '@hospitality/shared-types';
import { Types } from 'mongoose';
import { AuditLog, type AuditLogDocument } from '../../shared/audit/audit-log.model';
import { addDays, localDateTimeToUtc } from '../../shared/dates';
import { getTenantId } from '../../shared/request-context';
import type { PropertyService } from '../properties/property.service';
import { Staff } from '../staff/staff.model';
import { redactSummary } from './audit.redact';

export interface ListAuditInput {
  page: number;
  limit: number;
  from?: string | undefined;
  to?: string | undefined;
  action?: string | undefined;
  actorId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
}

export interface AuditService {
  /** Read-only. Newest first; entries are never changed or removed through this service. */
  list(input: ListAuditInput): Promise<{ items: AuditEntryDto[]; total: number }>;
}

type Stored = Pick<AuditLogDocument, 'actor' | 'action' | 'target' | 'summary' | 'at'> & {
  _id: Types.ObjectId;
};

/** `from` and `to` are property-local dates: the filter covers midnight to midnight there. */
function timeFilter(
  input: ListAuditInput,
  timezone: string,
): { $gte?: Date; $lt?: Date } | undefined {
  const bounds = {
    ...(input.from ? { $gte: localDateTimeToUtc(input.from, '00:00', timezone) } : {}),
    ...(input.to ? { $lt: localDateTimeToUtc(addDays(input.to, 1), '00:00', timezone) } : {}),
  };
  return Object.keys(bounds).length > 0 ? bounds : undefined;
}

function buildFilter(input: ListAuditInput, timezone: string): Record<string, unknown> {
  const at = timeFilter(input, timezone);
  return {
    ...(at ? { at } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.actorId ? { 'actor.id': input.actorId } : {}),
    ...(input.targetType ? { 'target.type': input.targetType } : {}),
    ...(input.targetId ? { 'target.id': input.targetId } : {}),
  };
}

/** The names of the staff who did the work, found with one extra query. */
async function staffNames(entries: readonly Stored[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      entries
        .filter((entry) => entry.actor.kind === 'staff' && Types.ObjectId.isValid(entry.actor.id))
        .map((entry) => entry.actor.id),
    ),
  ];
  if (ids.length === 0) return new Map();
  const people = await Staff.find({ _id: { $in: ids } }, { name: 1 }).lean();
  return new Map(people.map((person) => [person._id.toHexString(), person.name]));
}

function toEntryDto(entry: Stored, names: Map<string, string>): AuditEntryDto {
  return {
    id: entry._id.toHexString(),
    at: entry.at.toISOString(),
    actor: {
      kind: entry.actor.kind,
      id: entry.actor.id,
      role: entry.actor.role ?? null,
      name: entry.actor.kind === 'staff' ? (names.get(entry.actor.id) ?? null) : null,
    },
    action: entry.action,
    target: { type: entry.target.type, id: entry.target.id },
    summary: redactSummary(entry.summary),
  };
}

export function createAuditService(properties: PropertyService): AuditService {
  return {
    async list(input) {
      const tenant = getTenantId();
      if (!tenant) throw new Error('No tenant context');
      const { timezone } = await properties.get(tenant);
      const filter = buildFilter(input, timezone);

      const [entries, total] = await Promise.all([
        AuditLog.find(filter)
          .sort({ at: -1, _id: -1 })
          .skip((input.page - 1) * input.limit)
          .limit(input.limit)
          .lean<Stored[]>(),
        AuditLog.countDocuments(filter),
      ]);
      const names = await staffNames(entries);
      return { items: entries.map((entry) => toEntryDto(entry, names)), total };
    },
  };
}
