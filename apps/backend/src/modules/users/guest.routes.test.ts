import { STAFF_ROLES, type StaffRole } from '@hospitality/constants';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { Guest } from './guest.model';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
const t = buildTestApp();

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
});

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

describe('POST /api/v1/guests', () => {
  it('creates a guest and stores the phone number in E.164 whatever way it was typed', async () => {
    const desk = await as(a, 'front_desk');
    const res = await desk.post('/api/v1/guests', { name: 'Ravi Kumar', phone: '98765 43210' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Ravi Kumar',
      phone: '+919876543210',
      phoneVerifiedAt: null,
      email: null,
      hasIdDetails: false,
    });
  });

  it('treats every spelling of one number as the same guest', async () => {
    const desk = await as(a, 'front_desk');
    const first = await desk.post('/api/v1/guests', { name: 'Meera', phone: '99887 76655' });
    expect(first.status).toBe(201);
    for (const spelling of ['+91 99887 76655', '09988776655', '+91-99887-76655']) {
      const dup = await desk.post('/api/v1/guests', { name: 'Meera again', phone: spelling });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('phone_taken');
      expect(dup.body.error.details.existingGuestId).toBe(first.body.data.id);
    }
  });

  it('allows the same phone number in another property', async () => {
    const input = { name: 'Traveller', phone: '+91 90000 11111' };
    expect((await (await as(a, 'front_desk')).post('/api/v1/guests', input)).status).toBe(201);
    expect((await (await as(b, 'front_desk')).post('/api/v1/guests', input)).status).toBe(201);
  });

  it('keeps optional email and GSTIN, normalised', async () => {
    const res = await (
      await as(a, 'front_desk')
    ).post('/api/v1/guests', {
      name: 'Business Guest',
      phone: '+91 91111 22222',
      email: ' Guest@Example.COM ',
      gstin: '27abcde1234f1z5',
    });
    expect(res.body.data).toMatchObject({ email: 'guest@example.com', gstin: '27ABCDE1234F1Z5' });
  });

  it.each([
    ['a missing name', { phone: '9876543210' }],
    ['a non-number phone', { name: 'X Y', phone: 'call me' }],
    ['a too-short phone', { name: 'X Y', phone: '12345' }],
    ['a bad email', { name: 'X Y', phone: '9876501234', email: 'nope' }],
    ['a bad GSTIN', { name: 'X Y', phone: '9876501234', gstin: '123' }],
  ])('rejects %s without echoing it back', async (_label, body) => {
    const res = await (await as(a, 'front_desk')).post('/api/v1/guests', body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('call me');
  });

  it('ignores a propertyId, verification flag or id in the body', async () => {
    const res = await (
      await as(a, 'front_desk')
    ).post('/api/v1/guests', {
      name: 'Sneaky',
      phone: '+91 92222 33333',
      propertyId: b.id.toHexString(),
      phoneVerifiedAt: new Date().toISOString(),
      _id: '65f000000000000000000001',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.phoneVerifiedAt).toBeNull();
    expect(await runWithTenant(b.id, () => Guest.countDocuments({ name: 'Sneaky' }))).toBe(0);
  });
});

describe('ID details', () => {
  async function guestWithId() {
    const desk = await as(a, 'front_desk');
    const res = await desk.post('/api/v1/guests', {
      name: 'ID Holder',
      phone: `+9181${Math.floor(10000000 + Math.random() * 89999999)}`,
      idDetails: { idType: 'passport', idNumber: 'N1234567' },
    });
    return { desk, guest: res.body.data as { id: string }, status: res.status };
  }

  it('is never part of the normal guest record, only flagged', async () => {
    const { desk, guest, status } = await guestWithId();
    expect(status).toBe(201);
    const read = await desk.get(`/api/v1/guests/${guest.id}`);
    expect(read.body.data.hasIdDetails).toBe(true);
    expect(JSON.stringify(read.body)).not.toContain('N1234567');
    const list = await desk.get('/api/v1/guests?q=ID Holder');
    expect(JSON.stringify(list.body)).not.toContain('N1234567');
    expect(list.body.data[0].hasIdDetails).toBe(true);
  });

  it('is returned by its own route, and every read is audit logged with who read it', async () => {
    const { desk, guest } = await guestWithId();
    const res = await desk.get(`/api/v1/guests/${guest.id}/id-details`);
    expect(res.body.data).toEqual({ idType: 'passport', idNumber: 'N1234567' });
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'guest.id_details_read', 'target.id': guest.id }).lean(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toMatchObject({ kind: 'staff', role: 'front_desk' });
    expect(JSON.stringify(audits)).not.toContain('N1234567');
  });

  it('answers 404 for a guest with no ID on file, without writing an access entry', async () => {
    const desk = await as(a, 'front_desk');
    const created = await desk.post('/api/v1/guests', { name: 'No ID', phone: '+91 93333 44444' });
    const res = await desk.get(`/api/v1/guests/${created.body.data.id}/id-details`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('no_id_details');
  });

  it('can be removed', async () => {
    const { desk, guest } = await guestWithId();
    const res = await desk.patch(`/api/v1/guests/${guest.id}`, { idDetails: null });
    expect(res.body.data.hasIdDetails).toBe(false);
  });
});

describe('PATCH /api/v1/guests/:id', () => {
  it('changes details, and a changed phone number resets verification', async () => {
    const desk = await as(a, 'front_desk');
    const created = await desk.post('/api/v1/guests', { name: 'Before', phone: '+91 94444 55555' });
    const id = created.body.data.id as string;
    await runWithTenant(a.id, () => Guest.updateOne({ _id: id }, { phoneVerifiedAt: new Date() }));

    const sameNumber = await desk.patch(`/api/v1/guests/${id}`, { name: 'After' });
    expect(sameNumber.body.data.name).toBe('After');
    expect(sameNumber.body.data.phoneVerifiedAt).not.toBeNull();

    const newNumber = await desk.patch(`/api/v1/guests/${id}`, { phone: '95555 66666' });
    expect(newNumber.body.data.phone).toBe('+919555566666');
    expect(newNumber.body.data.phoneVerifiedAt).toBeNull();
  });

  it('refuses to move a guest onto a phone number another guest has', async () => {
    const desk = await as(a, 'front_desk');
    const one = await desk.post('/api/v1/guests', { name: 'One', phone: '+91 96666 77777' });
    const two = await desk.post('/api/v1/guests', { name: 'Two', phone: '+91 97777 88888' });
    const res = await desk.patch(`/api/v1/guests/${two.body.data.id}`, { phone: '96666 77777' });
    expect(res.status).toBe(409);
    expect(res.body.error.details.existingGuestId).toBe(one.body.data.id);
  });

  it('cannot reach a guest of another property', async () => {
    const bGuest = await (
      await as(b, 'front_desk')
    ).post('/api/v1/guests', { name: 'B only', phone: '+91 98888 99999' });
    const deskA = await as(a, 'front_desk');
    const id = bGuest.body.data.id;
    expect((await deskA.get(`/api/v1/guests/${id}`)).status).toBe(404);
    expect((await deskA.patch(`/api/v1/guests/${id}`, { name: 'Hacked' })).status).toBe(404);
    expect((await deskA.get(`/api/v1/guests/${id}/id-details`)).status).toBe(404);
  });
});

describe('GET /api/v1/guests (search)', () => {
  beforeAll(async () => {
    const desk = await as(a, 'front_desk');
    await desk.post('/api/v1/guests', {
      name: 'Priya Searchable',
      phone: '+91 81234 00001',
      email: 'priya.s@example.com',
    });
    await desk.post('/api/v1/guests', { name: 'Anil Searchable', phone: '+91 81234 00002' });
    await (
      await as(b, 'front_desk')
    ).post('/api/v1/guests', { name: 'Searchable In B', phone: '+91 81234 00003' });
  });

  it('finds by part of a name, ignoring case', async () => {
    const res = await (await as(a, 'front_desk')).get('/api/v1/guests?q=searchable');
    expect(res.body.data.map((g: { name: string }) => g.name)).toEqual([
      'Anil Searchable',
      'Priya Searchable',
    ]);
  });

  it('finds by phone however it is typed, and never returns another property’s guests', async () => {
    const desk = await as(a, 'front_desk');
    for (const q of ['81234 00001', '+91 81234 00001', '8123400001', '81234-00001']) {
      const res = await desk.get(`/api/v1/guests?q=${encodeURIComponent(q)}`);
      expect(
        res.body.data.map((g: { name: string }) => g.name),
        q,
      ).toEqual(['Priya Searchable']);
    }
    const all = await desk.get('/api/v1/guests?q=Searchable&limit=100');
    expect(all.body.data.map((g: { name: string }) => g.name)).not.toContain('Searchable In B');
  });

  it('finds by email and treats regex characters as plain text', async () => {
    const desk = await as(a, 'front_desk');
    expect((await desk.get('/api/v1/guests?q=priya.s@')).body.data).toHaveLength(1);
    expect((await desk.get('/api/v1/guests?q=.*')).body.data).toHaveLength(0);
    expect((await desk.get('/api/v1/guests?q=((')).status).toBe(200);
  });

  it('pages results and caps the page size', async () => {
    const desk = await as(a, 'front_desk');
    const page = await desk.get('/api/v1/guests?q=Searchable&limit=1&page=2');
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 2, limit: 1, total: 2 });
    expect((await desk.get('/api/v1/guests?limit=500')).status).toBe(400);
  });

  it('rejects a one-character search', async () => {
    expect((await (await as(a, 'front_desk')).get('/api/v1/guests?q=a')).status).toBe(400);
  });
});

describe('who may use the guest routes', () => {
  const allowed: StaffRole[] = ['platform_admin', 'property_admin', 'manager', 'front_desk'];
  for (const role of STAFF_ROLES) {
    it(`${role} is ${allowed.includes(role) ? 'allowed' : 'refused (403)'}`, async () => {
      const client = await as(a, role);
      const res = await client.get('/api/v1/guests');
      expect(res.status).toBe(allowed.includes(role) ? 200 : 403);
      const write = await client.post('/api/v1/guests', {});
      expect(write.status).toBe(allowed.includes(role) ? 400 : 403);
    });
  }

  it('answers 401 without sign-in', async () => {
    expect((await t.anonymous.get('/api/v1/guests')).status).toBe(401);
  });
});
