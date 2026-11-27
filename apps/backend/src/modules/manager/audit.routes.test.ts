import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { clientFor } from '../../../test/manager';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { localDateTimeToUtc } from '../../shared/dates';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';

useTestDatabase();

const TZ = 'Asia/Kolkata';
const D = '2026-05-10';
const t = buildTestApp();
let a: SeededProperty;
let b: SeededProperty;
let manager: Client;
let managerId: string;
let deskId: string;

const at = (date: string, time: string): Date => localDateTimeToUtc(date, time, TZ);

interface Plan {
  at: Date;
  actor: { kind: 'staff' | 'system' | 'guest'; id: string; role?: string };
  action: string;
  target: { type: string; id: string };
  summary?: Record<string, unknown>;
}

function plant(property: SeededProperty, plan: Plan) {
  return runWithTenant(property.id, () =>
    AuditLog.create({ ...plan, requestId: 'req-1', ip: '203.0.113.9' }),
  );
}

const SECRET_SUMMARY = {
  role: 'front_desk',
  email: 'new.person@grandplaza.example',
  temporaryPassword: 'Hunter2!-temporary',
  passwordHash: '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
  nested: { idNumber: '1234 5678 9012', otp: '482913', fine: 'keep me' },
  idDetails: { idType: 'aadhaar', idNumber: '9999 8888 7777' },
  list: [{ refreshToken: 'abc', label: 'also fine' }],
  // A secret that is not under a telling key is still caught by what it looks like.
  note: '$2b$12$zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
  jwtLike: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
};

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await clientFor(t, a, 'manager');
  managerId = a.staff.manager!.id.toHexString();
  deskId = a.staff.front_desk!.id.toHexString();
  const me = { kind: 'staff', id: managerId, role: 'manager' } as const;
  const desk = { kind: 'staff', id: deskId, role: 'front_desk' } as const;
  const system = { kind: 'system', id: 'system' } as const;

  await AuditLog.init();
  await plant(a, {
    at: at(D, '10:00'),
    actor: me,
    action: 'housekeeping.escalated',
    target: { type: 'service_request', id: 't1' },
    summary: { reason: 'Guest waiting' },
  });
  await plant(a, {
    at: at(D, '23:59'),
    actor: me,
    action: 'bill.line_added',
    target: { type: 'bill', id: 'b1' },
  });
  await plant(a, {
    at: at('2026-05-11', '00:30'),
    actor: desk,
    action: 'housekeeping.escalated',
    target: { type: 'service_request', id: 't2' },
  });
  await plant(a, {
    at: at('2026-05-09', '23:59'),
    actor: system,
    action: 'job.failed',
    target: { type: 'background_job', id: 'j1' },
    summary: { error: 'boom' },
  });
  await plant(a, {
    at: at('2026-05-12', '09:00'),
    actor: me,
    action: 'staff.created',
    target: { type: 'staff', id: 's1' },
    summary: SECRET_SUMMARY,
  });
  // Five entries at the very same moment: the order between them must still be stable.
  for (let index = 0; index < 5; index++) {
    await plant(a, {
      at: at('2026-05-20', '12:00'),
      actor: me,
      action: 'tie.break',
      target: { type: 'tie', id: `tie-${index}` },
    });
  }
  // 30 more, one second apart, for paging.
  for (let index = 0; index < 30; index++) {
    await plant(a, {
      at: new Date(at('2026-06-01', '08:00').getTime() + index * 1000),
      actor: desk,
      action: 'page.test',
      target: { type: 'page', id: `p-${index}` },
    });
  }
  await plant(b, {
    at: at(D, '10:00'),
    actor: { kind: 'staff', id: new Types.ObjectId().toHexString(), role: 'manager' },
    action: 'housekeeping.escalated',
    target: { type: 'service_request', id: 'b-t1' },
  });
});

const logs = (query = '', client: Client = manager) => client.get(`/api/v1/audit-logs${query}`);
const ids = (res: { body: { data: { target: { id: string } }[] } }): string[] =>
  res.body.data.map((entry) => entry.target.id);

describe('GET /audit-logs', () => {
  it('returns entries in the repo envelope with actor names resolved', async () => {
    const res = await logs(`?from=${D}&to=${D}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 25 });
    // Newest first.
    expect(res.body.data).toEqual([
      {
        id: expect.any(String),
        at: at(D, '23:59').toISOString(),
        actor: { kind: 'staff', id: managerId, role: 'manager', name: 'Grand Plaza manager' },
        action: 'bill.line_added',
        target: { type: 'bill', id: 'b1' },
        summary: null,
      },
      {
        id: expect.any(String),
        at: at(D, '10:00').toISOString(),
        actor: { kind: 'staff', id: managerId, role: 'manager', name: 'Grand Plaza manager' },
        action: 'housekeeping.escalated',
        target: { type: 'service_request', id: 't1' },
        summary: { reason: 'Guest waiting' },
      },
    ]);
  });

  it('turns from and to into the property-local day, not the UTC day', async () => {
    // 23:59 local on the 9th and 00:30 local on the 11th are outside; both are on the 10th in UTC.
    expect(ids(await logs(`?from=${D}&to=${D}`))).toEqual(['b1', 't1']);
    expect(ids(await logs('?from=2026-05-09&to=2026-05-09'))).toEqual(['j1']);
    expect(ids(await logs('?from=2026-05-11&to=2026-05-11'))).toEqual(['t2']);
    expect(ids(await logs(`?from=${D}&to=2026-05-11`))).toEqual(['t2', 'b1', 't1']);
  });

  it('describes a system actor without a name', async () => {
    const res = await logs('?actorId=system');
    expect(res.body.data).toEqual([
      expect.objectContaining({ actor: { kind: 'system', id: 'system', role: null, name: null } }),
    ]);
  });

  it('filters by action, actor, target type and target id, alone and together', async () => {
    expect(ids(await logs('?action=housekeeping.escalated'))).toEqual(['t2', 't1']);
    expect(ids(await logs(`?actorId=${deskId}&action=housekeeping.escalated`))).toEqual(['t2']);
    expect(ids(await logs('?targetType=bill'))).toEqual(['b1']);
    expect(ids(await logs('?targetType=service_request&targetId=t1'))).toEqual(['t1']);
    expect(ids(await logs('?targetId=nothing-here'))).toEqual([]);
    const none = await logs('?action=housekeeping.escalated&targetType=bill');
    expect(none.body.meta.total).toBe(0);
  });

  it('treats filter text as plain text, never as a pattern or an operator', async () => {
    expect((await logs('?action=.*')).body.meta.total).toBe(0);
    expect((await logs('?action[$ne]=x')).status).toBeLessThan(500);
  });

  it('pages newest first, ties broken by id, and reports the total', async () => {
    const first = await logs('?action=page.test&limit=10');
    expect(first.body.meta).toEqual({ total: 30, page: 1, limit: 10 });
    expect(ids(first)).toEqual(Array.from({ length: 10 }, (_, i) => `p-${29 - i}`));
    const last = await logs('?action=page.test&limit=10&page=3');
    expect(ids(last)).toEqual(Array.from({ length: 10 }, (_, i) => `p-${9 - i}`));
    expect((await logs('?action=page.test&limit=10&page=4')).body.data).toEqual([]);

    // Same timestamp: the later entry (larger id) comes first.
    expect(ids(await logs('?action=tie.break'))).toEqual([
      'tie-4',
      'tie-3',
      'tie-2',
      'tie-1',
      'tie-0',
    ]);
  });

  it('refuses a page size over 100, a backwards range and a range over 92 days', async () => {
    expect((await logs('?limit=100')).status).toBe(200);
    expect((await logs('?limit=101')).status).toBe(400);
    expect((await logs('?page=0')).status).toBe(400);
    expect((await logs('?from=2026-05-11&to=2026-05-10')).status).toBe(400);
    expect((await logs('?from=2026-01-01&to=2026-04-03')).status).toBe(400);
  });

  it('never shows another property’s entries', async () => {
    expect(ids(await logs(`?from=${D}&to=${D}&action=housekeeping.escalated`))).toEqual(['t1']);
    const managerB = await clientFor(t, b, 'manager');
    expect(ids(await logs(`?from=${D}&to=${D}`, managerB))).toEqual(['b-t1']);
  });
});

describe('GET /audit-logs: secrets never leave', () => {
  it('redacts passwords, hashes, tokens and ID document numbers', async () => {
    const res = await logs('?action=staff.created');
    const [entry] = res.body.data;
    expect(entry.summary).toEqual({
      role: 'front_desk',
      email: 'new.person@grandplaza.example',
      temporaryPassword: '[redacted]',
      passwordHash: '[redacted]',
      accessToken: '[redacted]',
      nested: { idNumber: '[redacted]', otp: '[redacted]', fine: 'keep me' },
      idDetails: '[redacted]',
      list: [{ refreshToken: '[redacted]', label: 'also fine' }],
      note: '[redacted]',
      jwtLike: '[redacted]',
    });

    const text = JSON.stringify(res.body);
    for (const secret of [
      'Hunter2',
      '$2a$10$',
      '$2b$12$',
      'eyJhbGci',
      '1234 5678',
      '9999 8888',
      '482913',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('does not expose the request id or IP address of the entry', async () => {
    const [entry] = (await logs('?action=job.failed')).body.data;
    expect(Object.keys(entry).sort()).toEqual(['action', 'actor', 'at', 'id', 'summary', 'target']);
  });
});

describe('the audit log stays append-only', () => {
  it('has no route to change or remove entries', async () => {
    const before = (await logs()).body.meta.total;
    expect((await manager.post('/api/v1/audit-logs', { action: 'x' })).status).toBe(404);
    expect((await manager.patch('/api/v1/audit-logs/abc', { action: 'x' })).status).toBe(404);
    expect((await manager.delete('/api/v1/audit-logs/abc')).status).toBe(404);
    expect((await logs()).body.meta.total).toBe(before);
  });

  it('has an index for looking entries up by person and time', () => {
    const wanted = JSON.stringify({ propertyId: 1, 'actor.id': 1, at: -1 });
    const indexes = AuditLog.schema.indexes().map(([fields]) => JSON.stringify(fields));
    expect(indexes).toContain(wanted);
  });
});
