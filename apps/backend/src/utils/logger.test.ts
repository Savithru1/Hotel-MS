import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

function capture(): { lines: () => string[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { stream, lines: () => chunks.join('').split('\n').filter(Boolean) };
}

describe('createLogger', () => {
  it('writes structured JSON log lines', () => {
    const { stream, lines } = capture();
    createLogger('info', stream).info({ bookingId: 'b-1' }, 'hello');
    const entry = JSON.parse(lines()[0] ?? '{}') as { msg: string; bookingId: string };
    expect(entry.msg).toBe('hello');
    expect(entry.bookingId).toBe('b-1');
  });

  it('respects the configured level', () => {
    const { stream, lines } = capture();
    const logger = createLogger('warn', stream);
    logger.info('quiet');
    logger.warn('loud');
    expect(lines()).toHaveLength(1);
  });

  it('can be silenced', () => {
    const { stream, lines } = capture();
    createLogger('silent', stream).error('nothing');
    expect(lines()).toHaveLength(0);
  });

  it('redacts credentials and secrets wherever they appear', () => {
    const { stream, lines } = capture();
    createLogger('info', stream).info(
      {
        req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sid=secret-cookie' } },
        res: { headers: { 'set-cookie': 'sid=secret-cookie' } },
        password: 'pw-top-level',
        user: { password: 'pw-nested', token: 'tok-nested', refreshToken: 'rt-nested' },
        body: { passwordHash: 'hash-value', otp: '123456' },
      },
      'request',
    );
    const output = lines().join('\n');
    for (const secret of [
      'abc.def.ghi',
      'secret-cookie',
      'pw-top-level',
      'pw-nested',
      'tok-nested',
      'rt-nested',
      'hash-value',
      '123456',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[Redacted]');
  });
});
