import type {
  HousekeepingStatus,
  MaintenanceCategory,
  MaintenancePriority,
  MaintenanceStatus,
  RequestPriority,
  ServiceRequestType,
} from '@hospitality/constants';

export interface AssigneeDto {
  id: string;
  name: string;
}

export interface HousekeepingRequestDto {
  id: string;
  type: ServiceRequestType;
  roomId: string;
  roomNumber: string | null;
  /** The in-house booking the request is for, when there is one. */
  bookingId: string | null;
  guestName: string | null;
  notes: string;
  priority: RequestPriority;
  status: HousekeepingStatus;
  assignedTo: AssigneeDto | null;
  escalated: boolean;
  escalationReason: string | null;
  source: 'front_desk' | 'housekeeping' | 'guest' | 'system';
  createdAt: string;
  completedAt: string | null;
}

export interface MaintenanceIssueDto {
  id: string;
  category: MaintenanceCategory;
  description: string;
  priority: MaintenancePriority;
  roomId: string;
  roomNumber: string | null;
  bookingId: string | null;
  /** True when this issue took the room out of service until it is resolved. */
  takesRoomOutOfService: boolean;
  status: MaintenanceStatus;
  assignedTo: AssigneeDto | null;
  escalated: boolean;
  escalationReason: string | null;
  resolutionNote: string | null;
  reportedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface QueueSummaryDto {
  /** Counts by status. */
  byStatus: Record<string, number>;
  escalated: number;
  /** Open items that are urgent. */
  urgent: number;
}
