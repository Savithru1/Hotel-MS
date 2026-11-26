import { STAFF_ROLES, type StaffRole } from '@hospitality/constants';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { defaultGstRuleSet } from './gst-defaults';

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

describe('GET /api/v1/properties/current', () => {
  it('returns the settings of the signed-in staff member’s own property to every role', async () => {
    for (const role of STAFF_ROLES) {
      const res = await (await as(a, role)).get('/api/v1/properties/current');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        slug: 'grand-plaza',
        stateName: 'Maharashtra',
        timezone: 'Asia/Kolkata',
        checkInTime: '14:00',
        checkOutTime: '11:00',
        currency: 'INR',
      });
    }
  });

  it('starts with the documented default GST rules', async () => {
    const res = await (await as(a, 'manager')).get('/api/v1/properties/current');
    const rules = res.body.data.gstRules;
    expect(rules).toHaveLength(1);
    expect(rules[0].room.slabs).toEqual([
      { upToPaise: 100_000, ratePercent: 0 },
      { upToPaise: 750_000, ratePercent: 5 },
      { upToPaise: null, ratePercent: 18 },
    ]);
    expect(rules[0].food).toMatchObject({ ratePercent: 5, highTariffRatePercent: 18 });
  });

  it('never shows another property', async () => {
    const res = await (await as(b, 'manager')).get('/api/v1/properties/current');
    expect(res.body.data.slug).toBe('sea-view');
  });

  it('needs a sign-in', async () => {
    expect((await t.anonymous.get('/api/v1/properties/current')).status).toBe(401);
  });
});

describe('PATCH /api/v1/properties/current', () => {
  const settings = {
    legalName: 'Grand Plaza Hospitality Pvt Ltd',
    address: { line1: '12 Marine Drive', city: 'Mumbai', state: 'Maharashtra', pincode: '400002' },
    gstin: '27ABCDE1234F1Z5',
    checkInTime: '13:00',
    checkOutTime: '12:00',
  };

  it('lets only the property admin change settings', async () => {
    for (const role of STAFF_ROLES) {
      const res = await (
        await as(a, role)
      ).patch('/api/v1/properties/current', { checkInTime: '14:00' });
      expect(res.status, role).toBe(
        role === 'property_admin' || role === 'platform_admin' ? 200 : 403,
      );
    }
  });

  it('saves legal name, address, GSTIN and times, and audits the change', async () => {
    const res = await (await as(a, 'property_admin')).patch('/api/v1/properties/current', settings);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      legalName: settings.legalName,
      gstin: settings.gstin,
      checkInTime: '13:00',
      checkOutTime: '12:00',
    });
    expect(res.body.data.address).toMatchObject({ city: 'Mumbai', pincode: '400002' });

    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'property.updated' }).lean(),
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(settings.gstin);
  });

  it.each([
    ['a malformed GSTIN', { gstin: '12345' }],
    ['a bad time', { checkInTime: '25:00' }],
    ['a bad timezone', { timezone: 'Mars/Olympus' }],
    ['a bad pincode', { address: { line1: 'x', city: 'y', state: 'z', pincode: '12' } }],
    ['an unknown department', { departments: ['laundry'] }],
    ['nothing at all', {}],
  ])('rejects %s', async (_label, body) => {
    const res = await (await as(a, 'property_admin')).patch('/api/v1/properties/current', body);
    expect(res.status).toBe(400);
  });

  it('can clear the GSTIN', async () => {
    const admin = await as(a, 'property_admin');
    await admin.patch('/api/v1/properties/current', { gstin: '27ABCDE1234F1Z5' });
    const res = await admin.patch('/api/v1/properties/current', { gstin: null });
    expect(res.body.data.gstin).toBeNull();
  });

  it('ignores slug, active and any propertyId in the body, and only ever changes the caller’s property', async () => {
    const admin = await as(a, 'property_admin');
    const res = await admin.patch('/api/v1/properties/current', {
      legalName: 'Only Mine Ltd',
      slug: 'stolen',
      active: false,
      propertyId: b.id.toHexString(),
      _id: b.id.toHexString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.slug).toBe('grand-plaza');
    const other = await (await as(b, 'manager')).get('/api/v1/properties/current');
    expect(other.body.data.legalName).not.toBe('Only Mine Ltd');
    // Signing in still works, so `active` was not changed.
    expect((await (await as(a, 'manager')).get('/api/v1/properties/current')).status).toBe(200);
  });
});

describe('POST /api/v1/properties/current/gst-rules', () => {
  it('adds a later rule set and keeps the earlier one untouched', async () => {
    const admin = await as(b, 'property_admin');
    const next = { ...defaultGstRuleSet('2027-04-01'), spaRecreation: { ratePercent: 12 } };
    const res = await admin.post('/api/v1/properties/current/gst-rules', next);
    expect(res.status).toBe(201);
    expect(res.body.data.gstRules).toHaveLength(2);
    expect(res.body.data.gstRules[0].spaRecreation.ratePercent).toBe(18);
    expect(res.body.data.gstRules[1].spaRecreation.ratePercent).toBe(12);
  });

  it('refuses a rule set that does not start after the latest one, so history is never rewritten', async () => {
    const admin = await as(a, 'property_admin');
    for (const effectiveFrom of ['2025-04-01', '2024-01-01']) {
      const res = await admin.post(
        '/api/v1/properties/current/gst-rules',
        defaultGstRuleSet(effectiveFrom),
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('gst_rules_not_after_latest');
    }
  });

  it('is for the property admin only', async () => {
    const rules = defaultGstRuleSet('2030-04-01');
    expect(
      (await (await as(a, 'manager')).post('/api/v1/properties/current/gst-rules', rules)).status,
    ).toBe(403);
    expect(
      (await (await as(a, 'front_desk')).post('/api/v1/properties/current/gst-rules', rules))
        .status,
    ).toBe(403);
  });

  it.each([
    [
      'slabs that go down',
      (r: ReturnType<typeof defaultGstRuleSet>) => ({
        ...r,
        room: {
          slabs: [
            { upToPaise: 500_000, ratePercent: 5 },
            { upToPaise: 100_000, ratePercent: 12 },
            { upToPaise: null, ratePercent: 18 },
          ],
        },
      }),
    ],
    [
      'a last slab with a limit',
      (r: ReturnType<typeof defaultGstRuleSet>) => ({
        ...r,
        room: { slabs: [{ upToPaise: 100_000, ratePercent: 5 }] },
      }),
    ],
    [
      'a rate above 100%',
      (r: ReturnType<typeof defaultGstRuleSet>) => ({ ...r, other: { ratePercent: 180 } }),
    ],
    [
      'a negative rate',
      (r: ReturnType<typeof defaultGstRuleSet>) => ({ ...r, other: { ratePercent: -1 } }),
    ],
    [
      'a fake date',
      (r: ReturnType<typeof defaultGstRuleSet>) => ({ ...r, effectiveFrom: '2031-13-45' }),
    ],
  ])('rejects %s', async (_label, mutate) => {
    const admin = await as(a, 'property_admin');
    const res = await admin.post(
      '/api/v1/properties/current/gst-rules',
      mutate(defaultGstRuleSet('2031-04-01')),
    );
    expect(res.status).toBe(400);
  });
});
