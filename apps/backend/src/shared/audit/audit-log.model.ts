import mongoose, { Schema, type Types } from 'mongoose';
import type { Principal } from '../request-context';
import { tenantPlugin } from '../tenant-plugin';

/** Thrown when anything tries to change or remove an audit entry. */
export class AuditImmutableError extends Error {
  constructor() {
    super('Audit log entries are append-only and cannot be changed or deleted.');
    this.name = 'AuditImmutableError';
  }
}

export interface AuditLogDocument {
  propertyId: Types.ObjectId;
  actor: Principal;
  action: string;
  target: { type: string; id: string };
  summary?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
  at: Date;
}

const auditLogSchema = new Schema<AuditLogDocument>(
  {
    actor: { type: Schema.Types.Mixed, required: true },
    action: { type: String, required: true, trim: true },
    target: { type: Schema.Types.Mixed, required: true },
    summary: { type: Schema.Types.Mixed },
    requestId: { type: String },
    ip: { type: String },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false },
);

auditLogSchema.index({ propertyId: 1, at: -1 });
auditLogSchema.index({ propertyId: 1, 'target.type': 1, 'target.id': 1, at: -1 });
auditLogSchema.index({ propertyId: 1, action: 1, at: -1 });
// "What did this person do?", for the manager audit screen.
auditLogSchema.index({ propertyId: 1, 'actor.id': 1, at: -1 });

function refuse(): never {
  throw new AuditImmutableError();
}

auditLogSchema.pre(
  [
    'updateOne',
    'updateMany',
    'replaceOne',
    'findOneAndUpdate',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  { query: true, document: false },
  refuse,
);
auditLogSchema.pre(['deleteOne', 'updateOne'], { query: false, document: true }, refuse);
auditLogSchema.pre('save', function () {
  if (!this.isNew) refuse();
});

auditLogSchema.plugin(tenantPlugin);

export const AuditLog =
  (mongoose.models.AuditLog as mongoose.Model<AuditLogDocument> | undefined) ??
  mongoose.model<AuditLogDocument>('AuditLog', auditLogSchema, 'audit_logs');
