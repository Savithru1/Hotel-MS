import {
  JOB_MAX_ATTEMPTS,
  JOB_STATUSES,
  JOB_TYPES,
  type JobStatus,
  type JobType,
} from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { tenantPlugin } from '../shared/tenant-plugin';

export const JOB_ERROR_MAX_CHARS = 500;

export interface JobDocument {
  _id: Types.ObjectId;
  /** Every job belongs to exactly one property and runs inside it. */
  propertyId: Types.ObjectId;
  type: JobType;
  payload: Record<string, unknown>;
  /** One job per property and key: used to keep recurring jobs to a single copy. */
  dedupeKey: string;
  runAt: Date;
  status: JobStatus;
  /** Starts counted when a worker claims the job. Reset when a recurring job finishes. */
  attempts: number;
  maxAttempts: number;
  /** While running: until when the claiming worker owns it. After that it can be reclaimed. */
  lockedUntil: Date | null;
  /** Identifies one claim. Finishing is filtered on it, so a worker that lost its lease cannot write. */
  lockToken: string | null;
  /** The message of the last failure, cut to 500 characters. Never a stack trace. */
  lastError: string | null;
  /** Set for jobs that run again and again; the same document is rescheduled. */
  recurring: { everyMs: number } | null;
  lastFinishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const jobSchema = new Schema<JobDocument>(
  {
    type: { type: String, enum: [...JOB_TYPES], required: true },
    payload: { type: Schema.Types.Mixed, default: () => ({}) },
    dedupeKey: { type: String, required: true, maxlength: 200 },
    runAt: { type: Date, required: true },
    status: { type: String, enum: [...JOB_STATUSES], default: 'pending', required: true },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: JOB_MAX_ATTEMPTS, min: 1 },
    lockedUntil: { type: Date, default: null },
    lockToken: { type: String, default: null },
    lastError: { type: String, default: null, maxlength: JOB_ERROR_MAX_CHARS },
    recurring: {
      type: new Schema({ everyMs: { type: Number, required: true, min: 1 } }, { _id: false }),
      default: null,
    },
    lastFinishedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

jobSchema.plugin(tenantPlugin);
// What the worker's claim query uses: due pending jobs, and running jobs whose lease ran out.
jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ status: 1, lockedUntil: 1 });
jobSchema.index(
  { propertyId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

export const BackgroundJob =
  (mongoose.models.BackgroundJob as mongoose.Model<JobDocument> | undefined) ??
  mongoose.model<JobDocument>('BackgroundJob', jobSchema, 'background_jobs');
