import type { NotificationService } from '../../modules/notifications/notification.service';
import type { Clock, JobHandler } from '../worker';

export interface NotificationCleanupOptions {
  clock: Clock;
  notifications: Pick<NotificationService, 'purgeOld'>;
}

/**
 * Removes unread notifications older than 90 days from the job's property. Read ones are
 * removed by MongoDB's own TTL index 30 days after they were read. Safe to run twice.
 */
export function createNotificationCleanupHandler({
  clock,
  notifications,
}: NotificationCleanupOptions): JobHandler {
  return async () => {
    await notifications.purgeOld(clock.now());
  };
}
