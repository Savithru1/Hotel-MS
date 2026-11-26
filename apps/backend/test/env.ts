import { parseEnv, type Env } from '../src/config/environment';

/** A complete, valid configuration for tests. bcrypt is made cheap so tests stay fast. */
export const TEST_ENV_VARS: Record<string, string> = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/hospitality_platform?replicaSet=rs0',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789',
  JWT_REFRESH_SECRET: 'test-refresh-secret-fedcba9876543210fedcba9876',
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:5174',
  BCRYPT_COST: '4',
};

export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({ ...TEST_ENV_VARS, ...overrides });
}
