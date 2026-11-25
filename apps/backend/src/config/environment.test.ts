import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from './environment';

const valid = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/hospitality_platform?replicaSet=rs0',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:5174',
} satisfies Record<string, string>;

function messageOf(raw: Record<string, string | undefined>): string {
  try {
    parseEnv(raw);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected parseEnv to throw');
}

describe('parseEnv', () => {
  it('returns typed values and sensible defaults for a valid environment', () => {
    const env = parseEnv(valid);

    expect(env.NODE_ENV).toBe('test');
    expect(env.PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.TRUST_PROXY).toBe(0);
    expect(env.ENABLE_DOCS).toBe(true);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:5174']);
  });

  it('coerces PORT and TRUST_PROXY from strings', () => {
    const env = parseEnv({ ...valid, PORT: '8080', TRUST_PROXY: '1' });
    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(1);
  });

  it('trims whitespace around CORS origins and drops empty entries', () => {
    const env = parseEnv({ ...valid, CORS_ORIGINS: ' http://a.test , ,http://b.test ' });
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('turns API docs off by default in production and on elsewhere', () => {
    expect(parseEnv({ ...valid, NODE_ENV: 'production' }).ENABLE_DOCS).toBe(false);
    expect(parseEnv({ ...valid, NODE_ENV: 'development' }).ENABLE_DOCS).toBe(true);
    expect(parseEnv({ ...valid, NODE_ENV: 'production', ENABLE_DOCS: 'true' }).ENABLE_DOCS).toBe(
      true,
    );
  });

  it.each([
    ['MONGODB_URI', undefined],
    ['MONGODB_URI', ''],
    ['JWT_ACCESS_SECRET', undefined],
    ['JWT_ACCESS_SECRET', ''],
    ['JWT_REFRESH_SECRET', undefined],
    ['CORS_ORIGINS', undefined],
  ])('fails fast when %s is %j (there are no fallback secrets)', (key, value) => {
    expect(() => parseEnv({ ...valid, [key]: value })).toThrow(EnvValidationError);
    expect(messageOf({ ...valid, [key]: value })).toContain(key);
  });

  it('rejects JWT secrets shorter than 32 characters', () => {
    expect(() => parseEnv({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(EnvValidationError);
  });

  it('rejects using the same secret for access and refresh tokens', () => {
    const same = 'c'.repeat(40);
    expect(() => parseEnv({ ...valid, JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same })).toThrow(
      /different/i,
    );
  });

  it('only accepts MongoDB connection strings', () => {
    expect(() => parseEnv({ ...valid, MONGODB_URI: 'postgres://localhost/db' })).toThrow(
      EnvValidationError,
    );
    expect(() => parseEnv({ ...valid, MONGODB_URI: 'redis://localhost' })).toThrow(
      EnvValidationError,
    );
    expect(
      parseEnv({ ...valid, MONGODB_URI: 'mongodb+srv://u:p@cluster.example.net/db' }).MONGODB_URI,
    ).toContain('mongodb+srv://');
  });

  it.each(['*', 'not a url', 'localhost:5173', 'ftp://example.test'])(
    'rejects CORS origin %j (explicit http(s) origins only)',
    (origin) => {
      expect(() => parseEnv({ ...valid, CORS_ORIGINS: origin })).toThrow(EnvValidationError);
    },
  );

  it.each(['0', '65536', 'abc', '-1', '40.5'])('rejects PORT %j', (port) => {
    expect(() => parseEnv({ ...valid, PORT: port })).toThrow(EnvValidationError);
  });

  it('rejects an unknown NODE_ENV or LOG_LEVEL', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, LOG_LEVEL: 'loud' })).toThrow(EnvValidationError);
  });

  it('reports every problem at once', () => {
    const message = messageOf({ ...valid, MONGODB_URI: undefined, PORT: 'abc' });
    expect(message).toContain('MONGODB_URI');
    expect(message).toContain('PORT');
  });

  it('never prints secret values in its error message', () => {
    const secret = 'hunter2-this-is-secret';
    const message = messageOf({ ...valid, JWT_ACCESS_SECRET: secret.slice(0, 10) });
    expect(message).not.toContain(secret.slice(0, 10));
    expect(messageOf({ ...valid, MONGODB_URI: 'postgres://user:p4ssw0rd@host/db' })).not.toContain(
      'p4ssw0rd',
    );
  });
});
