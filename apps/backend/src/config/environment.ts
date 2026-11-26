import { z } from 'zod';

/** Thrown at startup when the environment is wrong. The message never contains values. */
export class EnvValidationError extends Error {
  constructor(problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

const secret = z
  .string({ error: 'is required' })
  .min(32, 'must be at least 32 characters (generate one with a cryptographic random generator)');

const corsOrigins = z
  .string({ error: 'is required (comma-separated list of allowed origins)' })
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(z.url({ protocol: /^https?$/, error: 'must be a full http(s) origin, not "*"' }))
      .min(1, 'needs at least one origin'),
  )
  .transform((origins) => origins.map((origin) => new URL(origin).origin));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    MONGODB_URI: z
      .string({ error: 'is required' })
      .refine(
        (uri) => /^mongodb(\+srv)?:\/\//.test(uri),
        'must be a MongoDB connection string (mongodb:// or mongodb+srv://)',
      ),
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    CORS_ORIGINS: corsOrigins,
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    /** bcrypt work factor. 12 is slow enough to resist guessing; tests use a low value. */
    BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    /** `mongo` is only needed once a second backend instance runs. */
    SOCKET_ADAPTER: z.enum(['memory', 'mongo']).default('memory'),
    ENABLE_DOCS: z.enum(['true', 'false']).optional(),
  })
  .superRefine((env, context) => {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'must be different from JWT_ACCESS_SECRET',
      });
    }
  })
  .transform((env) => ({
    ...env,
    // API docs are on while developing and off in production unless explicitly enabled.
    ENABLE_DOCS: env.ENABLE_DOCS ? env.ENABLE_DOCS === 'true' : env.NODE_ENV !== 'production',
  }));

export type Env = z.output<typeof schema>;

/** Validates a raw environment. Throws `EnvValidationError` listing every problem at once. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || 'environment';
    return `${name}: ${issue.message}`;
  });
  throw new EnvValidationError(problems);
}

export function loadEnv(): Env {
  return parseEnv(process.env);
}
