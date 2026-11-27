import type { Logger } from 'pino';
import type { BillingService } from '../../modules/billing/billing.service';
import type { JobHandler } from '../worker';

export interface BillingSyncOptions {
  billing: Pick<BillingService, 'syncOpenBills'>;
  logger: Pick<Logger, 'error'>;
}

/**
 * Brings the bill of every checked-in guest up to date, so the manager's revenue figures include
 * nights, delivered orders and finished sessions even before anyone opens a bill. Each failed
 * booking is logged and the others carry on. If nothing at all could be synced the job fails, so
 * it is retried and managers are told, instead of looking healthy while every bill is stale.
 * Safe to run twice: posting a line is idempotent.
 */
export function createBillingSyncHandler({ billing, logger }: BillingSyncOptions): JobHandler {
  return async (job) => {
    const { synced, failures } = await billing.syncOpenBills();
    for (const failure of failures) {
      logger.error(
        { err: failure.error, bookingId: failure.bookingId, jobId: job.id },
        'Could not bring a bill up to date',
      );
    }
    if (synced === 0 && failures.length > 0) {
      throw new Error(`${failures.length} bills could not be synced`);
    }
  };
}
