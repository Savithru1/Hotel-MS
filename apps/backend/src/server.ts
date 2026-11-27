import { createServer } from 'node:http';
import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { EnvValidationError, loadEnv } from './config/environment';
import { createNotificationCleanupHandler } from './jobs/handlers/notification-cleanup';
import { createSlaScanHandler } from './jobs/handlers/sla-scan';
import { createScheduler } from './jobs/scheduler';
import { createWorker, systemClock } from './jobs/worker';
import { startNotifier } from './modules/notifications/notifier';
import { attachGateway } from './realtime/gateway';
import { eventBus } from './shared/events/event-bus';
import { buildServices } from './services';
import { createLogger } from './utils/logger';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  await connectDatabase(env.MONGODB_URI);
  logger.info('Connected to MongoDB');

  const services = buildServices(env);
  const app = createApp({ env, logger, services });
  const server = createServer(app);
  const gateway = await attachGateway({
    httpServer: server,
    env,
    tokens: services.tokens,
    auth: services.auth,
    bus: eventBus,
    logger,
  });
  const notifier = startNotifier({
    bus: eventBus,
    notifications: services.notifications,
    logger,
  });

  // Background jobs run in this process. With several instances the claim in the worker makes
  // sure each job still runs once at a time.
  const worker = createWorker({
    clock: systemClock,
    pollMs: env.JOB_POLL_MS,
    logger,
    notifications: services.notifications,
    handlers: {
      'sla.scan': createSlaScanHandler({
        clock: systemClock,
        notifications: services.notifications,
      }),
      'notifications.cleanup': createNotificationCleanupHandler({
        clock: systemClock,
        notifications: services.notifications,
      }),
    },
  });
  const scheduler = createScheduler({ clock: systemClock, logger });
  if (env.JOBS_ENABLED) {
    scheduler.start();
    worker.start();
    logger.info({ pollMs: env.JOB_POLL_MS }, 'Background jobs started');
  } else {
    logger.info('Background jobs are switched off (JOBS_ENABLED=false)');
  }

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
  });

  const shutdownInOrder = async (): Promise<void> => {
    await scheduler.stop();
    await worker.stop();
    notifier.stop();
    await notifier.idle();
    await gateway.close();
    await disconnectDatabase();
  };

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Shutdown took too long, forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    // Let the job in flight finish before the connections it needs are closed.
    void shutdownInOrder().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'Error while shutting down');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // The logger may not exist yet (the environment is what configures it), so write directly.
  const message =
    error instanceof EnvValidationError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to start the API.\n${message}\n`);
  process.exit(1);
});
