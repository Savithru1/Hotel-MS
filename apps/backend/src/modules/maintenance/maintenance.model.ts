import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUSES,
  MAINTENANCE_TRANSITIONS,
  type MaintenanceCategory,
  type MaintenancePriority,
  type MaintenanceStatus,
} from '@hospitality/constants';
import mongoose, { Schema, type Types } from 'mongoose';
import { defineStateMachine, stateFields, type HistoryEntry } from '../../shared/state-machine';
import { tenantPlugin } from '../../shared/tenant-plugin';

/** New -> Assigned -> In Progress -> Resolved. Handing over to someone else is Assigned -> Assigned. */
export const maintenanceMachine = defineStateMachine<MaintenanceStatus>({
  name: 'maintenance issue',
  initial: 'new',
  transitions: Object.fromEntries(
    MAINTENANCE_STATUSES.map((status) => [status, MAINTENANCE_TRANSITIONS[status]]),
  ) as Record<MaintenanceStatus, readonly MaintenanceStatus[]>,
});

export interface MaintenanceIssueDocument {
  _id: Types.ObjectId;
  propertyId: Types.ObjectId;
  category: MaintenanceCategory;
  description: string;
  priority: MaintenancePriority;
  priorityRank: number;
  roomId: Types.ObjectId;
  bookingId: Types.ObjectId | null;
  takesRoomOutOfService: boolean;
  status: MaintenanceStatus;
  history: HistoryEntry[];
  assignedTo: Types.ObjectId | null;
  escalated: boolean;
  escalationReason: string | null;
  escalatedAt: Date | null;
  resolutionNote: string | null;
  reportedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const maintenanceIssueSchema = new Schema<MaintenanceIssueDocument>(
  {
    category: { type: String, enum: [...MAINTENANCE_CATEGORIES], required: true },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    priority: { type: String, enum: [...MAINTENANCE_PRIORITIES], default: 'medium' },
    priorityRank: { type: Number, default: 1 },
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    takesRoomOutOfService: { type: Boolean, default: false },
    ...stateFields(maintenanceMachine),
    assignedTo: { type: Schema.Types.ObjectId, ref: 'Staff', default: null },
    escalated: { type: Boolean, default: false },
    escalationReason: { type: String, default: null },
    escalatedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: null },
    reportedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

maintenanceIssueSchema.plugin(tenantPlugin);
maintenanceIssueSchema.index({ propertyId: 1, status: 1, priorityRank: -1, createdAt: 1 });
maintenanceIssueSchema.index({ propertyId: 1, roomId: 1, status: 1 });
maintenanceIssueSchema.index({ propertyId: 1, assignedTo: 1, status: 1 });

export const MaintenanceIssue =
  (mongoose.models.MaintenanceIssue as mongoose.Model<MaintenanceIssueDocument> | undefined) ??
  mongoose.model<MaintenanceIssueDocument>(
    'MaintenanceIssue',
    maintenanceIssueSchema,
    'maintenance_issues',
  );
