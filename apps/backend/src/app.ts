import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { isDatabaseConnected } from './config/database';
import type { Env } from './config/environment';
import { healthRouter } from './health';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { createRateLimiter, type RateLimitOptions } from './middleware/rate-limit';
import { requestContext } from './middleware/request-context';
import type { LoginLimits } from './modules/auth/auth.routes';
import { buildApiRouter } from './routes';
import { buildOpenApiDocument } from './shared/openapi';

export interface AppOptions {
  env: Env;
  logger: Logger;
  /** Overridable so the app can be tested without a database. Defaults to the real connection. */
  checkDatabase?: () => boolean;
  rateLimit?: RateLimitOptions;
  /** Overridable so sign-in limits can be tested without hundreds of requests. */
  loginLimits?: LoginLimits;
}

const DEFAULT_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, limit: 300 };
const JSON_BODY_LIMIT = '100kb';

/**
 * Builds the Express app. Order matters: context and logging first, then security headers and
 * CORS, then the routes that must never be rate limited (health, docs), then the rate limiter,
 * body parsing, the API routes, and finally 404 and error handling.
 */
export function createApp({
  env,
  logger,
  checkDatabase,
  rateLimit,
  loginLimits,
}: AppOptions): Express {
  const app = express();
  // Building the routes registers them in the API docs, so this must happen before the docs.
  const api = buildApiRouter({ env, ...(loginLimits ? { loginLimits } : {}) });

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestContext());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => String(req.id),
      autoLogging: { ignore: (req) => req.url === '/health' },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true, maxAge: 600 }));

  app.use(healthRouter(checkDatabase ?? isDatabaseConnected));

  if (env.ENABLE_DOCS) {
    const document = buildOpenApiDocument();
    app.get('/openapi.json', (_req, res) => {
      res.json(document);
    });
    app.use(
      '/docs',
      // Swagger UI needs inline scripts and styles, which the default content security policy
      // blocks. Only the docs page is relaxed.
      (_req: Request, res: Response, next: NextFunction) => {
        res.removeHeader('Content-Security-Policy');
        next();
      },
      swaggerUi.serve,
      swaggerUi.setup(document),
    );
  }

  app.use(createRateLimiter(rateLimit ?? DEFAULT_RATE_LIMIT));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
