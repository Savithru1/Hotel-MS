import type { StaffRole } from '@hospitality/constants';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../../test/db';
import { buildTestApp, type Client } from '../../../test/http';
import { AuditLog } from '../../shared/audit/audit-log.model';
import { runWithTenant } from '../../shared/request-context';
import { seedDevelopmentData, type SeededProperty } from '../seed/seed';
import { MenuItem } from './menu-item.model';

useTestDatabase();

let a: SeededProperty;
let b: SeededProperty;
const t = buildTestApp();

const as = (property: SeededProperty, role: StaffRole): Promise<Client> => {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.actAs(staff.id, property.id);
};

let manager: Client;
let kitchen: Client;
let otherManager: Client;

beforeAll(async () => {
  [a, b] = (await seedDevelopmentData({ bcryptCost: 4 })) as [SeededProperty, SeededProperty];
  manager = await as(a, 'manager');
  kitchen = await as(a, 'kitchen');
  otherManager = await as(b, 'manager');
});

const ITEMS = '/api/v1/menu/items';
let counter = 0;
const item = (extra: Record<string, unknown> = {}) => ({
  name: `Dish ${++counter}`,
  category: 'Mains',
  pricePaise: 25_000,
  ...extra,
});

async function addItem(client: Client = manager, extra: Record<string, unknown> = {}) {
  const res = await client.post(ITEMS, item(extra));
  expect(res.status).toBe(201);
  return res.body.data as { id: string; name: string };
}

describe('creating menu items', () => {
  it('lets a manager add an item with options and fills the defaults', async () => {
    const res = await manager.post(ITEMS, {
      name: 'Paneer Butter Masala',
      category: 'Mains',
      description: 'Creamy tomato gravy',
      pricePaise: 32_000,
      options: [
        { name: 'Spice level', required: true, choices: [{ label: 'Mild' }, { label: 'Hot' }] },
        {
          name: 'Add-ons',
          multiple: true,
          choices: [{ label: 'Extra cheese', pricePaise: 3_000 }],
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Paneer Butter Masala',
      category: 'Mains',
      description: 'Creamy tomato gravy',
      pricePaise: 32_000,
      available: true,
      hasImage: false,
    });
    expect(res.body.data.options[0]).toEqual({
      name: 'Spice level',
      required: true,
      multiple: false,
      choices: [
        { label: 'Mild', pricePaise: 0 },
        { label: 'Hot', pricePaise: 0 },
      ],
    });
    expect(res.body.data.options[1].choices[0]).toEqual({
      label: 'Extra cheese',
      pricePaise: 3_000,
    });
  });

  it('records who added it in the audit log', async () => {
    const created = await addItem();
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'menu.created', 'target.id': created.id }).lean(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toMatchObject({ id: a.staff.manager?.id.toHexString() });
  });

  it('refuses a second item with the same name in the same property, whatever the case', async () => {
    await addItem(manager, { name: 'Masala Chai' });
    const again = await manager.post(ITEMS, item({ name: ' masala CHAI ' }));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('duplicate_item');
  });

  it('lets another property use the same name', async () => {
    await addItem(manager, { name: 'Shared Name' });
    const res = await otherManager.post(ITEMS, item({ name: 'Shared Name' }));
    expect(res.status).toBe(201);
  });

  it('ignores a property id, image id or image flag sent by the client', async () => {
    const res = await manager.post(
      ITEMS,
      item({ propertyId: b.id.toHexString(), imageId: b.id.toHexString(), hasImage: true }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.hasImage).toBe(false);
    expect(
      await runWithTenant(b.id, () => MenuItem.countDocuments({ _id: res.body.data.id })),
    ).toBe(0);
    expect(
      await runWithTenant(a.id, () => MenuItem.countDocuments({ _id: res.body.data.id })),
    ).toBe(1);
  });

  it('rejects bad prices, empty names and broken options with a 400', async () => {
    const group = { name: 'Size', choices: [{ label: 'Small' }] };
    for (const bad of [
      item({ pricePaise: 0 }),
      item({ pricePaise: 12.5 }),
      item({ pricePaise: 99_999_999 }),
      item({ name: '' }),
      item({ category: '' }),
      item({ options: [{ ...group, choices: [] }] }),
      item({ options: [group, { ...group, name: 'SIZE' }] }),
      { category: 'Mains', pricePaise: 100 },
    ]) {
      const res = await manager.post(ITEMS, bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_error');
    }
  });
});

describe('who may manage and who may read the menu', () => {
  it('lets only management add, change or remove items', async () => {
    const existing = await addItem();
    for (const role of [
      'front_desk',
      'kitchen',
      'housekeeping',
      'maintenance',
      'spa_recreation',
    ] as const) {
      const client = await as(a, role);
      expect((await client.post(ITEMS, item())).status, role).toBe(403);
      expect(
        (await client.patch(`${ITEMS}/${existing.id}`, { available: false })).status,
        role,
      ).toBe(403);
      expect((await client.delete(`${ITEMS}/${existing.id}`)).status, role).toBe(403);
    }
    for (const role of ['property_admin', 'manager'] as const) {
      const client = await as(a, role);
      expect((await client.post(ITEMS, item())).status, role).toBe(201);
    }
  });

  it('lets the kitchen, front desk and management read, and keeps everyone else out', async () => {
    for (const role of ['kitchen', 'front_desk', 'manager', 'property_admin'] as const) {
      expect((await (await as(a, role)).get(ITEMS)).status, role).toBe(200);
    }
    for (const role of ['housekeeping', 'maintenance', 'spa_recreation'] as const) {
      expect((await (await as(a, role)).get(ITEMS)).status, role).toBe(403);
    }
    expect((await t.anonymous.get(ITEMS)).status).toBe(401);
  });
});

describe('listing and reading', () => {
  it('lists items by category then name, with filters and paging', async () => {
    const category = `Cat-${Date.now()}`;
    await addItem(manager, { name: 'Zeta soup', category });
    await addItem(manager, { name: 'Alpha salad', category });
    const hidden = await addItem(manager, { name: 'Mid stew', category });
    await manager.patch(`${ITEMS}/${hidden.id}`, { available: false });

    const all = await kitchen.get(`${ITEMS}?category=${category}&limit=100`);
    expect(all.status).toBe(200);
    expect(all.body.data.map((i: { name: string }) => i.name)).toEqual([
      'Alpha salad',
      'Mid stew',
      'Zeta soup',
    ]);
    expect(all.body.meta).toMatchObject({ total: 3, page: 1, limit: 100 });

    const onlyAvailable = await kitchen.get(`${ITEMS}?category=${category}&available=true`);
    expect(onlyAvailable.body.data.map((i: { name: string }) => i.name)).toEqual([
      'Alpha salad',
      'Zeta soup',
    ]);

    const page2 = await kitchen.get(`${ITEMS}?category=${category}&limit=2&page=2`);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.meta.total).toBe(3);
  });

  it('never shows another property’s items', async () => {
    const mine = await addItem(manager, { name: 'Only In Property A' });
    const theirs = await otherManager.get(`${ITEMS}?limit=100`);
    expect(theirs.body.data.map((i: { id: string }) => i.id)).not.toContain(mine.id);
    expect((await otherManager.get(`${ITEMS}/${mine.id}`)).status).toBe(404);
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    expect((await manager.get(`${ITEMS}/0123456789abcdef01234567`)).status).toBe(404);
    expect((await manager.get(`${ITEMS}/not-an-id`)).status).toBe(400);
  });
});

describe('changing and removing items', () => {
  it('changes only the fields that were sent', async () => {
    const created = await addItem(manager, {
      name: 'Dal Tadka',
      description: 'Yellow lentils',
      options: [{ name: 'Size', choices: [{ label: 'Full' }] }],
    });
    const res = await manager.patch(`${ITEMS}/${created.id}`, { pricePaise: 21_000 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Dal Tadka',
      description: 'Yellow lentils',
      pricePaise: 21_000,
      available: true,
    });
    expect(res.body.data.options).toHaveLength(1);
  });

  it('switches availability on and off and audits what changed', async () => {
    const created = await addItem();
    const off = await manager.patch(`${ITEMS}/${created.id}`, { available: false });
    expect(off.body.data.available).toBe(false);
    const on = await manager.patch(`${ITEMS}/${created.id}`, { available: true });
    expect(on.body.data.available).toBe(true);
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'menu.updated', 'target.id': created.id }).lean(),
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]?.summary).toMatchObject({ fields: ['available'] });
  });

  it('refuses an empty change, a duplicate name and an unknown item', async () => {
    const one = await addItem(manager, { name: 'Rename Me' });
    await addItem(manager, { name: 'Taken Name' });
    expect((await manager.patch(`${ITEMS}/${one.id}`, {})).status).toBe(400);
    const dup = await manager.patch(`${ITEMS}/${one.id}`, { name: 'taken name' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_item');
    const missing = await manager.patch(`${ITEMS}/0123456789abcdef01234567`, { available: false });
    expect(missing.status).toBe(404);
  });

  it('lets an item keep its own name when other fields change', async () => {
    const created = await addItem(manager, { name: 'Keep My Name' });
    const res = await manager.patch(`${ITEMS}/${created.id}`, {
      name: 'Keep My Name',
      pricePaise: 100,
    });
    expect(res.status).toBe(200);
  });

  it('cannot touch another property’s item', async () => {
    const mine = await addItem();
    expect((await otherManager.patch(`${ITEMS}/${mine.id}`, { available: false })).status).toBe(
      404,
    );
    expect((await otherManager.delete(`${ITEMS}/${mine.id}`)).status).toBe(404);
    expect((await manager.get(`${ITEMS}/${mine.id}`)).body.data.available).toBe(true);
  });

  it('removes an item, audits it and then answers 404', async () => {
    const created = await addItem();
    const res = await manager.delete(`${ITEMS}/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: created.id });
    expect((await manager.get(`${ITEMS}/${created.id}`)).status).toBe(404);
    expect((await manager.delete(`${ITEMS}/${created.id}`)).status).toBe(404);
    const audits = await runWithTenant(a.id, () =>
      AuditLog.find({ action: 'menu.deleted', 'target.id': created.id }).lean(),
    );
    expect(audits).toHaveLength(1);
  });
});

// A real 1x1 PNG, so the bytes are a genuine image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0, 0, 0]),
  Buffer.from('WEBP'),
  Buffer.alloc(24),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');

async function tokenFor(property: SeededProperty, role: StaffRole): Promise<string> {
  const staff = property.staff[role];
  if (!staff) throw new Error(`no ${role}`);
  return t.tokens.signAccessToken({ staffId: staff.id, propertyId: property.id });
}

async function upload(
  property: SeededProperty,
  role: StaffRole,
  id: string,
  body: Buffer,
  contentType: string,
) {
  return request(t.app)
    .put(`${ITEMS}/${id}/image`)
    .set('Authorization', `Bearer ${await tokenFor(property, role)}`)
    .set('Content-Type', contentType)
    .send(body);
}

async function fetchImage(property: SeededProperty, role: StaffRole, id: string) {
  return request(t.app)
    .get(`${ITEMS}/${id}/image`)
    .set('Authorization', `Bearer ${await tokenFor(property, role)}`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
}

const imageFiles = async (): Promise<number> =>
  (await mongoose.connection.db?.collection('menu_images.files').countDocuments()) ?? -1;

describe('menu images', () => {
  it('stores an uploaded image and serves the same bytes back to staff who can read the menu', async () => {
    const created = await addItem();
    const put = await upload(a, 'manager', created.id, PNG, 'image/png');
    expect(put.status).toBe(200);
    expect(put.body.data.hasImage).toBe(true);

    for (const role of ['manager', 'kitchen', 'front_desk'] as const) {
      const got = await fetchImage(a, role, created.id);
      expect(got.status, role).toBe(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      // Even if a polyglot file slipped through, the browser may run nothing from this response.
      expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(got.headers['cache-control']).toMatch(/private/);
      expect(Buffer.compare(got.body as Buffer, PNG)).toBe(0);
    }
    expect((await manager.get(`${ITEMS}/${created.id}`)).body.data.hasImage).toBe(true);
  });

  it('accepts JPEG and WebP as well', async () => {
    const jpg = await addItem();
    const webp = await addItem();
    expect((await upload(a, 'manager', jpg.id, JPEG, 'image/jpeg')).status).toBe(200);
    expect((await upload(a, 'manager', webp.id, WEBP, 'image/webp')).status).toBe(200);
    expect((await fetchImage(a, 'manager', jpg.id)).headers['content-type']).toBe('image/jpeg');
    expect((await fetchImage(a, 'manager', webp.id)).headers['content-type']).toBe('image/webp');
  });

  it('checks the real bytes, not the declared type', async () => {
    const created = await addItem();
    const html = Buffer.from('<script>alert(1)</script>');
    for (const [body, type] of [
      [html, 'image/png'],
      [SVG, 'image/png'],
      [PNG, 'image/jpeg'],
      [JPEG, 'image/webp'],
    ] as const) {
      const res = await upload(a, 'manager', created.id, body, type);
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe('unsupported_image');
    }
    expect((await manager.get(`${ITEMS}/${created.id}`)).body.data.hasImage).toBe(false);
  });

  it('refuses types that are not allowed, such as SVG, and an empty body', async () => {
    const created = await addItem();
    expect((await upload(a, 'manager', created.id, SVG, 'image/svg+xml')).status).toBe(415);
    expect((await upload(a, 'manager', created.id, PNG, 'text/html')).status).toBe(415);
    const empty = await upload(a, 'manager', created.id, Buffer.alloc(0), 'image/png');
    expect([400, 415]).toContain(empty.status);
  });

  it('refuses an image over 2 MB', async () => {
    const created = await addItem();
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const res = await upload(a, 'manager', created.id, big, 'image/png');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('lets only management change images, but the kitchen and front desk can see them', async () => {
    const created = await addItem();
    for (const role of ['front_desk', 'kitchen', 'housekeeping'] as const) {
      expect((await upload(a, role, created.id, PNG, 'image/png')).status, role).toBe(403);
    }
    await upload(a, 'manager', created.id, PNG, 'image/png');
    expect((await fetchImage(a, 'housekeeping', created.id)).status).toBe(403);
    expect((await kitchen.delete(`${ITEMS}/${created.id}/image`)).status).toBe(403);
  });

  it('keeps one image per item: a new upload replaces the old file', async () => {
    const created = await addItem();
    const before = await imageFiles();
    await upload(a, 'manager', created.id, PNG, 'image/png');
    await upload(a, 'manager', created.id, JPEG, 'image/jpeg');
    expect(await imageFiles()).toBe(before + 1);
    expect((await fetchImage(a, 'manager', created.id)).headers['content-type']).toBe('image/jpeg');
  });

  it('tags the stored file with its property and never serves it across properties', async () => {
    const created = await addItem();
    await upload(a, 'manager', created.id, PNG, 'image/png');
    const file = await mongoose.connection.db
      ?.collection('menu_images.files')
      .findOne({ 'metadata.menuItemId': created.id });
    expect(String(file?.metadata?.propertyId)).toBe(a.id.toHexString());

    expect((await fetchImage(b, 'manager', created.id)).status).toBe(404);
    expect((await upload(b, 'manager', created.id, JPEG, 'image/jpeg')).status).toBe(404);
    expect((await otherManager.delete(`${ITEMS}/${created.id}/image`)).status).toBe(404);
    expect((await fetchImage(a, 'manager', created.id)).headers['content-type']).toBe('image/png');
  });

  it('answers 404 when an item has no image', async () => {
    const created = await addItem();
    expect((await fetchImage(a, 'manager', created.id)).status).toBe(404);
  });

  it('removes the image when asked, and when the item itself is deleted', async () => {
    const one = await addItem();
    const two = await addItem();
    const before = await imageFiles();
    await upload(a, 'manager', one.id, PNG, 'image/png');
    await upload(a, 'manager', two.id, PNG, 'image/png');
    expect(await imageFiles()).toBe(before + 2);

    const removed = await manager.delete(`${ITEMS}/${one.id}/image`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.hasImage).toBe(false);
    expect((await fetchImage(a, 'manager', one.id)).status).toBe(404);
    expect(await imageFiles()).toBe(before + 1);

    await manager.delete(`${ITEMS}/${two.id}`);
    expect(await imageFiles()).toBe(before);
  });
});

describe('the menu is in the API documentation', () => {
  it('lists the menu routes', async () => {
    const res = await request(t.app).get('/openapi.json');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/menu/items',
        '/api/v1/menu/items/{id}',
        '/api/v1/menu/items/{id}/image',
      ]),
    );
  });
});
