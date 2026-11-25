import { Schema, type HydratedDocument, type Types } from 'mongoose';
import { getContext } from './request-context';

/** Thrown when a tenant-scoped model is used with no tenant context (a bug, never a user error). */
export class TenantContextError extends Error {
  constructor(operation: string) {
    super(
      `No tenant context for "${operation}". Run it inside runWithTenant() or, for code that ` +
        'is deliberately not acting for one property, inside runAsPlatform().',
    );
    this.name = 'TenantContextError';
  }
}

/** Thrown when code tries to write a document that belongs to a different property. */
export class TenantMismatchError extends Error {
  constructor(operation: string) {
    super(`Refused "${operation}": the document belongs to a different property.`);
    this.name = 'TenantMismatchError';
  }
}

/** Thrown for operations that cannot be restricted to one property and so are not allowed. */
export class TenantPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantPolicyError';
  }
}

type Scope = { tenantId: Types.ObjectId } | { platform: true };

function currentScope(operation: string): Scope {
  const context = getContext();
  if (context?.platform) return { platform: true };
  if (context?.propertyId) return { tenantId: context.propertyId };
  throw new TenantContextError(operation);
}

/** The slice of a mongoose Query this plugin needs, kept narrow on purpose. */
interface RestrictableQuery {
  op?: string;
  and(conditions: Record<string, unknown>[]): unknown;
  getUpdate(): unknown;
  setUpdate(update: unknown): unknown;
  getOptions(): { upsert?: boolean };
}

const REPLACE_OPERATIONS = ['replaceOne', 'findOneAndReplace'];
const UPDATE_OPERATIONS = ['updateOne', 'updateMany', 'findOneAndUpdate'];

interface UpdateDocument {
  $rename?: Record<string, string>;
  $setOnInsert?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Makes an update safe for one tenant: pipeline-style updates are refused (they run as written
 * and could rewrite `propertyId`), `$rename` may not touch `propertyId`, and an upsert always
 * inserts into the current property whatever `$setOnInsert` says.
 */
function restrictUpdate(query: RestrictableQuery, tenantId: Types.ObjectId): void {
  const update = query.getUpdate();

  if (Array.isArray(update)) {
    throw new TenantPolicyError(
      'Pipeline-style updates cannot be limited to one property and are not allowed for a ' +
        'property request. Use update operators such as $set instead.',
    );
  }
  if (update === null || typeof update !== 'object') return;

  const document = update as UpdateDocument;
  const rename = document.$rename;
  if (rename && ('propertyId' in rename || Object.values(rename).includes('propertyId'))) {
    throw new TenantMismatchError('update ($rename of propertyId)');
  }
  if (query.getOptions().upsert) {
    query.setUpdate({
      ...document,
      $setOnInsert: { ...document.$setOnInsert, propertyId: tenantId },
    });
  }
}

const QUERY_OPERATIONS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
] as const;

/** Aggregation stages that read from, or write to, another collection. */
const CROSS_COLLECTION_STAGES = ['$lookup', '$graphLookup', '$unionWith', '$out', '$merge'];
/** Stages that describe the whole server or collection rather than one tenant's documents. */
const SERVER_WIDE_STAGES = ['$collStats', '$indexStats', '$currentOp', '$listSessions'];
/** Stages MongoDB insists on running first; the tenant filter goes straight after them. */
const MUST_BE_FIRST_STAGES = ['$geoNear', '$search', '$searchMeta', '$vectorSearch'];

function containsKey(value: unknown, names: readonly string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = containsKey(item, names);
      if (hit) return hit;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (names.includes(key)) return key;
      const hit = containsKey(nested, names);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Makes a schema belong to exactly one property (tenant).
 *
 * - Adds a required, indexed, immutable `propertyId`.
 * - Every query is ANDed with the current tenant. A caller-supplied `propertyId`, `$or` or `$ne`
 *   can only narrow the result, never widen it to another tenant.
 * - New documents are stamped with the current tenant; a document for another tenant is refused.
 * - Aggregations are restricted to the tenant, and cannot reach into other collections.
 * - `bulkWrite` and `estimatedDocumentCount` cannot be scoped, so they are refused for tenants.
 * - With no tenant context and no `runAsPlatform`, every operation throws instead of returning
 *   unscoped data.
 *
 * Note: raw driver access through `Model.collection` bypasses all of this and must not be used
 * outside platform code.
 */
export function tenantPlugin(schema: Schema): void {
  schema.add({
    propertyId: {
      type: Schema.Types.ObjectId,
      ref: 'Property',
      required: true,
      index: true,
      immutable: true,
    },
  });

  schema.pre(
    [...QUERY_OPERATIONS],
    { query: true, document: false },
    function (this: RestrictableQuery) {
      const scope = currentScope(this.op ?? 'query');
      if ('tenantId' in scope) {
        this.and([{ propertyId: scope.tenantId }]);

        if (UPDATE_OPERATIONS.includes(this.op ?? '')) {
          restrictUpdate(this, scope.tenantId);
        }

        // A replacement swaps the whole document. Without this it would drop `propertyId`
        // (orphaning the record) or move it to whatever property the caller put in it.
        if (REPLACE_OPERATIONS.includes(this.op ?? '')) {
          const replacement = (this.getUpdate() ?? {}) as Record<string, unknown>;
          this.setUpdate({ ...replacement, propertyId: scope.tenantId });
        }
      }
    },
  );

  schema.pre('estimatedDocumentCount', function () {
    const scope = currentScope('estimatedDocumentCount');
    if ('tenantId' in scope) {
      throw new TenantPolicyError(
        'estimatedDocumentCount cannot be limited to one property, use countDocuments instead.',
      );
    }
  });

  schema.pre('aggregate', function () {
    const scope = currentScope('aggregate');
    if (!('tenantId' in scope)) return;

    const pipeline = this.pipeline();
    const options = this.options as { tenantAllowCrossCollection?: boolean };
    const allowCrossCollection = options.tenantAllowCrossCollection === true;
    delete options.tenantAllowCrossCollection;

    const serverWide = containsKey(pipeline, SERVER_WIDE_STAGES);
    if (serverWide) {
      throw new TenantPolicyError(`Aggregation stage ${serverWide} is not allowed for a property.`);
    }
    const crossCollection = containsKey(pipeline, CROSS_COLLECTION_STAGES);
    if (crossCollection && !allowCrossCollection) {
      throw new TenantPolicyError(
        `Aggregation stage ${crossCollection} could read other properties' data. ` +
          'Restrict it to the tenant and opt in with .option({ tenantAllowCrossCollection: true }).',
      );
    }

    const first = Object.keys(pipeline[0] ?? {})[0];
    const insertAt = first && MUST_BE_FIRST_STAGES.includes(first) ? 1 : 0;
    pipeline.splice(insertAt, 0, { $match: { propertyId: scope.tenantId } });
  });

  schema.pre('bulkWrite', function () {
    const scope = currentScope('bulkWrite');
    if ('tenantId' in scope) {
      throw new TenantPolicyError(
        'bulkWrite skips the property scoping hooks and is not allowed for a property request.',
      );
    }
  });

  schema.pre('validate', function (this: HydratedDocument<{ propertyId?: Types.ObjectId }>) {
    const scope = currentScope('save');
    if (!('tenantId' in scope)) return;

    const current = this.get('propertyId') as Types.ObjectId | undefined;
    if (!current) {
      this.set('propertyId', scope.tenantId);
    } else if (!current.equals(scope.tenantId)) {
      throw new TenantMismatchError('save');
    }
  });
}
