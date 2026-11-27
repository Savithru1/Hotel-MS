import {
  HOUSEKEEPING_STATUSES,
  HOUSEKEEPING_TRANSITIONS,
  REQUEST_PRIORITIES,
  SERVICE_REQUEST_TYPES,
  type HousekeepingStatus,
  type RequestPriority,
  type ServiceRequestType,
} from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { defineStateMachine, stateFields, type HistoryEntry } from '../../shared/state-machine';
import { tenantPlugin } from '../../shared/tenant-plugin';

/** New -> In Progress -> Completed (or Cancelled before work starts). */
export const housekeepingMachine = defineStateMachine<HousekeepingStatus>({
  name: 'housekeeping request',
  initial: 'new',
  transitions: Object.fromEntries(
    HOUSEKEEPING_STATUSES.map((status) => [status, HOUSEKEEPING_TRANSITIONS[status]]),
  ) as Record<HousekeepingStatus, readonly HousekeepingStatus[]>,
});

export interface ServiceRequestDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  type: ServiceRequestType;
  roomId: Types.ObjectId;
  bookingId: Types.ObjectId | null;
  guestName: string | null;
  notes: string;
  priority: RequestPriority;
  /** 1 for urgent, 0 for normal, so queues can sort urgent work first. */
  priorityRank: number;
  status: HousekeepingStatus;
  history: HistoryEntry[];
  assignedTo: Types.ObjectId | null;
  escalated: boolean;
  escalationReason: string | null;
  escalatedAt: Date | null;
  source: 'front_desk' | 'housekeeping' | 'guest' | 'system';
  createdBy: string | null;
  completedAt: Date | null;
  /** When managers were reminded that this took too long. Set once; claimed atomically. */
  slaRemindedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Housekeeping requests and cleaning tasks. The collection is called `service_requests` because
 * the guest app (P1.12) files requests of the same kind.
 */
const serviceRequestSchema = new Schema<ServiceRequestDocument>(
  {
    type: { type: String, enum: [...SERVICE_REQUEST_TYPES], required: true },
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    guestName: { type: String, default: null },
    notes: { type: String, default: '', maxlength: 500 },
    priority: { type: String, enum: [...REQUEST_PRIORITIES], default: 'normal' },
    priorityRank: { type: Number, default: 0 },
    ...stateFields(housekeepingMachine),
    assignedTo: { type: Schema.Types.ObjectId, ref: 'Staff', default: null },
    escalated: { type: Boolean, default: false },
    escalationReason: { type: String, default: null },
    escalatedAt: { type: Date, default: null },
    source: {
      type: String,
      enum: ['front_desk', 'housekeeping', 'guest', 'system'],
      default: 'front_desk',
    },
    createdBy: { type: String, default: null },
    completedAt: { type: Date, default: null },
    slaRemindedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

serviceRequestSchema.plugin(tenantPlugin);
serviceRequestSchema.index({ propertyId: 1, status: 1, priorityRank: -1, createdAt: 1 });
serviceRequestSchema.index({ propertyId: 1, roomId: 1, status: 1 });
serviceRequestSchema.index({ propertyId: 1, status: 1, slaRemindedAt: 1, createdAt: 1 });
serviceRequestSchema.index({ propertyId: 1, assignedTo: 1, status: 1 });

export const ServiceRequest =
  (mongoose.models.ServiceRequest as mongoose.Model<ServiceRequestDocument> | undefined) ??
  mongoose.model<ServiceRequestDocument>(
    'ServiceRequest',
    serviceRequestSchema,
    'service_requests',
  );
