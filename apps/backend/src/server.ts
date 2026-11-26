import { createServer } from 'node:http';
import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './config/database';
import { EnvValidationError, loadEnv } from './config/environment';
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
  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
  });

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

    void gateway.close().then(() => {
      disconnectDatabase()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error({ err: error }, 'Error while disconnecting');
          process.exit(1);
        });
    });
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
