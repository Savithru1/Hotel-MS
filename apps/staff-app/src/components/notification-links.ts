import type { StaffRole } from '@hospitality/constants';
import type { NotificationLinkKind } from '@hospitality/constants';
import { canOpen } from '../auth/permissions';

/** The screen that shows each kind of record. Notifications carry only a kind and an id. */
const PAGE_FOR: Record<NotificationLinkKind, string> = {
  housekeeping: '/housekeeping',
  maintenance: '/maintenance',
  food_order: '/kitchen',
  // A job that failed for good is written to the audit log, which is where a manager looks.
  job: '/audit',
};

/** Where a notification leads for this role, or `null` when the role may not open that page. */
export function notificationPath(role: StaffRole, kind: NotificationLinkKind): string | null {
  const path = PAGE_FOR[kind];
  return canOpen(role, path) ? path : null;
}
