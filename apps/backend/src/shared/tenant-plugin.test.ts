import mongoose, { Schema, type Types } from 'mongoose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { twoTenants, useTestDatabase } from '../../test/db';
import { runAsPlatform, runWithTenant } from './request-context';
import { TenantContextError, TenantMismatchError, tenantPlugin } from './tenant-plugin';

useTestDatabase();

interface Widget {
  name: string;
  qty: number;
  propertyId: Types.ObjectId;
}

const widgetSchema = new Schema<Widget>({
  name: { type: String, required: true },
  qty: { type: Number, default: 0 },
});
widgetSchema.plugin(tenantPlugin);
const Widget = mongoose.model<Widget>('Widget', widgetSchema);

const { a: A, b: B } = twoTenants();

async function seed(): Promise<void> {
  await runAsPlatform(async () => {
    await Widget.deleteMany({});
    await Widget.create([
      { propertyId: A, name: 'a-1', qty: 1 },
      { propertyId: A, name: 'a-2', qty: 2 },
      { propertyId: B, name: 'b-1', qty: 10 },
    ]);
  });
}

const inPlatform = <T>(fn: () => Promise<T>): Promise<T> => runAsPlatform(fn);

beforeAll(async () => {
  await Widget.init();
});
beforeEach(seed);

describe('tenant plugin: reads', () => {
  it('only returns the current tenant documents', async () => {
    const found = await runWithTenant(A, () => Widget.find().sort({ name: 1 }));
    expect(found.map((w) => w.name)).toEqual(['a-1', 'a-2']);
  });

  it('cannot find another tenant document by id, by filter, or by findOne', async () => {
    const other = await inPlatform(() => Widget.findOne({ name: 'b-1' }));
    expect(other).not.toBeNull();
    await runWithTenant(A, async () => {
      expect(await Widget.findById(other?._id)).toBeNull();
      expect(await Widget.findOne({ name: 'b-1' })).toBeNull();
      expect(await Widget.find({ _id: other?._id })).toEqual([]);
    });
  });

  it('counts and distincts within the tenant only', async () => {
    await runWithTenant(A, async () => {
      expect(await Widget.countDocuments()).toBe(2);
      expect((await Widget.distinct('name')).sort()).toEqual(['a-1', 'a-2']);
    });
  });

  it('cannot be tricked by a caller-supplied propertyId filter', async () => {
    await runWithTenant(A, async () => {
      expect(await Widget.find({ propertyId: B })).toEqual([]);
      expect(await Widget.find({ propertyId: { $ne: A } })).toEqual([]);
      expect(await Widget.find({ propertyId: { $in: [A, B] } })).toHaveLength(2);
    });
  });

  it('cannot be tricked by an $or that includes another tenant', async () => {
    await runWithTenant(A, async () => {
      const found = await Widget.find({ $or: [{ propertyId: B }, { name: 'a-1' }] });
      expect(found.map((w) => w.name)).toEqual(['a-1']);
    });
  });

  it('sees every tenant in platform mode', async () => {
    expect(await inPlatform(() => Widget.countDocuments())).toBe(3);
  });

  it('survives awaits and runs concurrent tenants without mixing them', async () => {
    const [forA, forB] = await Promise.all([
      runWithTenant(A, async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return Widget.find();
      }),
      runWithTenant(B, async () => Widget.find()),
    ]);
    expect(forA).toHaveLength(2);
    expect(forB).toHaveLength(1);
  });
});

describe('tenant plugin: writes', () => {
  it('stamps new documents with the current tenant', async () => {
    const created = await runWithTenant(A, () => Widget.create({ name: 'new' }));
    expect(created.propertyId.equals(A)).toBe(true);
  });

  it('refuses to create a document for another tenant', async () => {
    await expect(
      runWithTenant(A, () => Widget.create({ name: 'sneaky', propertyId: B })),
    ).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it('stamps and checks insertMany too', async () => {
    const created = await runWithTenant(A, () =>
      Widget.insertMany([{ name: 'm1' }, { name: 'm2' }]),
    );
    expect(created.every((w) => w.propertyId.equals(A))).toBe(true);

    await expect(
      runWithTenant(A, () => Widget.insertMany([{ name: 'ok' }, { name: 'bad', propertyId: B }])),
    ).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it('updates and deletes only the current tenant documents', async () => {
    await runWithTenant(A, async () => {
      const updated = await Widget.updateMany({}, { $set: { qty: 99 } });
      expect(updated.modifiedCount).toBe(2);
    });
    const other = await inPlatform(() => Widget.findOne({ name: 'b-1' }));
    expect(other?.qty).toBe(10);

    await runWithTenant(A, async () => {
      expect((await Widget.deleteMany({})).deletedCount).toBe(2);
    });
    expect(await inPlatform(() => Widget.countDocuments())).toBe(1);
  });

  it('cannot update, replace or delete another tenant document by id', async () => {
    const other = await inPlatform(() => Widget.findOne({ name: 'b-1' }));
    await runWithTenant(A, async () => {
      expect((await Widget.updateOne({ _id: other?._id }, { qty: 0 })).matchedCount).toBe(0);
      expect(await Widget.findOneAndUpdate({ _id: other?._id }, { qty: 0 })).toBeNull();
      expect(await Widget.findByIdAndDelete(other?._id)).toBeNull();
      expect((await Widget.replaceOne({ _id: other?._id }, { name: 'x' })).matchedCount).toBe(0);
      expect((await Widget.deleteOne({ _id: other?._id })).deletedCount).toBe(0);
    });
    expect((await inPlatform(() => Widget.findOne({ name: 'b-1' })))?.qty).toBe(10);
  });

  it('keeps propertyId immutable on update and save', async () => {
    const mine = await runWithTenant(A, () => Widget.findOne({ name: 'a-1' }));
    await runWithTenant(A, async () => {
      await Widget.updateOne({ _id: mine?._id }, { $set: { propertyId: B } });
    });
    expect((await inPlatform(() => Widget.findById(mine?._id)))?.propertyId.equals(A)).toBe(true);

    if (mine) {
      mine.propertyId = B;
      await runWithTenant(A, () => mine.save());
    }
    expect((await inPlatform(() => Widget.findById(mine?._id)))?.propertyId.equals(A)).toBe(true);
  });

  it('refuses to save a document under a different tenant context', async () => {
    const mine = await runWithTenant(A, () => Widget.findOne({ name: 'a-1' }));
    expect(mine).not.toBeNull();
    if (!mine) return;
    mine.qty = 123;
    await expect(runWithTenant(B, () => mine.save())).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it('requires an explicit propertyId in platform mode', async () => {
    await expect(inPlatform(() => Widget.create({ name: 'orphan' }))).rejects.toThrow(/propertyId/);
    const ok = await inPlatform(() => Widget.create({ name: 'explicit', propertyId: B }));
    expect(ok.propertyId.equals(B)).toBe(true);
  });

  it('blocks bulkWrite for tenant requests (it would bypass the scoping hooks)', async () => {
    await expect(
      runWithTenant(A, () =>
        Widget.bulkWrite([{ updateMany: { filter: {}, update: { $set: { qty: 0 } } } }]),
      ),
    ).rejects.toThrow(/bulkWrite/);
    expect((await inPlatform(() => Widget.findOne({ name: 'b-1' })))?.qty).toBe(10);
  });
});

describe('tenant plugin: aggregate', () => {
  it('restricts every pipeline to the current tenant', async () => {
    const result = await runWithTenant(A, () =>
      Widget.aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: '$qty' } } }]),
    );
    expect(result[0]?.total).toBe(3);
  });

  it('cannot be widened by a $match on another tenant', async () => {
    const result = await runWithTenant(A, () => Widget.aggregate([{ $match: { propertyId: B } }]));
    expect(result).toEqual([]);
  });

  it('refuses pipelines that reach into other collections unless explicitly allowed', async () => {
    const pipeline = [
      { $lookup: { from: 'widgets', localField: 'name', foreignField: 'name', as: 'x' } },
    ];
    await expect(runWithTenant(A, () => Widget.aggregate(pipeline))).rejects.toThrow(/\$lookup/);
    await expect(
      runWithTenant(A, () => Widget.aggregate([{ $unionWith: 'widgets' }])),
    ).rejects.toThrow(/\$unionWith/);
    await expect(
      runWithTenant(A, () =>
        Widget.aggregate(pipeline).option({ tenantAllowCrossCollection: true }),
      ),
    ).resolves.toBeDefined();
  });
});

describe('tenant plugin: no context', () => {
  it('throws instead of returning unscoped data', async () => {
    await expect(Widget.find()).rejects.toBeInstanceOf(TenantContextError);
    await expect(Widget.findOne({})).rejects.toBeInstanceOf(TenantContextError);
    await expect(Widget.countDocuments()).rejects.toBeInstanceOf(TenantContextError);
    await expect(Widget.updateMany({}, { qty: 1 })).rejects.toBeInstanceOf(TenantContextError);
    await expect(Widget.deleteMany({})).rejects.toBeInstanceOf(TenantContextError);
    await expect(Widget.distinct('name')).rejects.toBeInstanceOf(TenantContextError);
    await expect(Widget.aggregate([{ $match: {} }])).rejects.toBeInstanceOf(TenantContextError);
    await expect(Widget.create({ name: 'x' })).rejects.toBeInstanceOf(TenantContextError);
    await expect(Widget.insertMany([{ name: 'x' }])).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe('tenant plugin: schema', () => {
  it('adds a required, indexed, immutable propertyId path', () => {
    const path = widgetSchema.path('propertyId') as unknown as {
      isRequired: boolean;
      options: { index?: boolean; immutable?: boolean };
    };
    expect(path.isRequired).toBe(true);
    expect(path.options.index).toBe(true);
    expect(path.options.immutable).toBe(true);
  });
});

describe('tenant plugin: operations that cannot be scoped', () => {
  it('refuses estimatedDocumentCount for a property, but allows it for the platform', async () => {
    await expect(runWithTenant(A, () => Widget.estimatedDocumentCount())).rejects.toThrow(
      /estimatedDocumentCount/,
    );
    expect(await inPlatform(() => Widget.estimatedDocumentCount())).toBeGreaterThanOrEqual(3);
    await expect(Widget.estimatedDocumentCount()).rejects.toBeInstanceOf(TenantContextError);
  });

  it('refuses server-wide aggregation stages for a property', async () => {
    await expect(
      runWithTenant(A, () => Widget.aggregate([{ $collStats: { count: {} } }])),
    ).rejects.toThrow(/\$collStats/);
    await expect(runWithTenant(A, () => Widget.aggregate([{ $indexStats: {} }]))).rejects.toThrow(
      /\$indexStats/,
    );
  });

  it('still restricts the base collection when a cross-collection stage is allowed', async () => {
    const result = await runWithTenant(A, () =>
      Widget.aggregate([
        { $lookup: { from: 'widgets', localField: 'name', foreignField: 'name', as: 'same' } },
        { $project: { name: 1 } },
      ]).option({ tenantAllowCrossCollection: true }),
    );
    expect(result.map((row: { name: string }) => row.name).sort()).toEqual(['a-1', 'a-2']);
  });

  it('lets platform code run any pipeline', async () => {
    const result = await inPlatform(() =>
      Widget.aggregate([{ $group: { _id: null, total: { $sum: '$qty' } } }]),
    );
    expect(result[0]?.total).toBe(13);
  });
});

describe('tenant plugin: whole-document replacement', () => {
  it('keeps the document in its property when it is replaced', async () => {
    const mine = await runWithTenant(A, () => Widget.findOne({ name: 'a-1' }));
    await runWithTenant(A, () =>
      Widget.replaceOne({ _id: mine?._id }, { name: 'replaced', qty: 5 }),
    );

    const after = await inPlatform(() => Widget.findById(mine?._id));
    expect(after?.name).toBe('replaced');
    expect(after?.propertyId?.equals(A)).toBe(true);
    expect(await runWithTenant(A, () => Widget.countDocuments())).toBe(2);
  });

  it('keeps the document in its property with findOneAndReplace', async () => {
    const mine = await runWithTenant(A, () => Widget.findOne({ name: 'a-2' }));
    await runWithTenant(A, () =>
      Widget.findOneAndReplace({ _id: mine?._id }, { name: 'replaced-2', qty: 6 }),
    );

    const after = await inPlatform(() => Widget.findById(mine?._id));
    expect(after?.name).toBe('replaced-2');
    expect(after?.propertyId?.equals(A)).toBe(true);
  });

  it('cannot move a document to another property by replacing it', async () => {
    const mine = await runWithTenant(A, () => Widget.findOne({ name: 'a-1' }));
    await runWithTenant(A, () =>
      Widget.replaceOne({ _id: mine?._id }, { name: 'moved', qty: 1, propertyId: B }),
    );
    const after = await inPlatform(() => Widget.findById(mine?._id));
    expect(after?.propertyId?.equals(A)).toBe(true);
  });
});

describe('tenant plugin: other read and write paths', () => {
  it('creates upserted documents inside the current property', async () => {
    await runWithTenant(A, async () => {
      await Widget.findOneAndUpdate({ name: 'upsert-1' }, { $set: { qty: 1 } }, { upsert: true });
      await Widget.updateOne({ name: 'upsert-2' }, { $set: { qty: 2 } }, { upsert: true });
    });
    const created = await inPlatform(() => Widget.find({ name: /^upsert-/ }));
    expect(created).toHaveLength(2);
    expect(created.every((w) => w.propertyId?.equals(A))).toBe(true);
  });

  it('cannot upsert into another property through $setOnInsert', async () => {
    await runWithTenant(A, () =>
      Widget.updateOne(
        { name: 'upsert-sneaky' },
        { $set: { qty: 1 }, $setOnInsert: { propertyId: B } },
        { upsert: true },
      ),
    );
    const created = await inPlatform(() => Widget.find({ name: 'upsert-sneaky' }));
    expect(created.every((w) => w.propertyId?.equals(A))).toBe(true);
  });

  it('cannot remove propertyId with $unset', async () => {
    const mine = await runWithTenant(A, () => Widget.findOne({ name: 'a-1' }));
    await runWithTenant(A, () =>
      Widget.updateOne({ _id: mine?._id }, { $unset: { propertyId: 1 } }),
    );
    const after = await inPlatform(() => Widget.findById(mine?._id));
    expect(after?.propertyId?.equals(A)).toBe(true);
  });

  it('scopes exists() and cursors', async () => {
    const other = await inPlatform(() => Widget.findOne({ name: 'b-1' }));
    await runWithTenant(A, async () => {
      expect(await Widget.exists({ _id: other?._id })).toBeNull();
      expect(await Widget.exists({ name: 'a-1' })).not.toBeNull();

      const names: string[] = [];
      for await (const doc of Widget.find().cursor()) names.push(doc.name);
      expect(names.sort()).toEqual(['a-1', 'a-2']);
    });
  });

  it('refuses bulkSave for a property request', async () => {
    const mine = await runWithTenant(A, () => Widget.findOne({ name: 'a-1' }));
    if (!mine) throw new Error('seed missing');
    mine.qty = 50;
    await expect(runWithTenant(A, () => Widget.bulkSave([mine]))).rejects.toThrow();
    expect((await inPlatform(() => Widget.findById(mine._id)))?.qty).toBe(1);
  });
});

describe('tenant plugin: update operators cannot reach propertyId', () => {
  it('refuses pipeline-style updates for a property (they bypass schema protection)', async () => {
    const mine = await runWithTenant(A, () => Widget.findOne({ name: 'a-1' }));
    await expect(
      runWithTenant(A, () =>
        Widget.updateOne({ _id: mine?._id }, [{ $set: { propertyId: B } }], {
          updatePipeline: true,
        }),
      ),
    ).rejects.toThrow(/pipeline/i);
    expect((await inPlatform(() => Widget.findById(mine?._id)))?.propertyId?.equals(A)).toBe(true);
  });

  it('refuses $rename into or out of propertyId', async () => {
    const mine = await runWithTenant(A, () => Widget.findOne({ name: 'a-1' }));
    await expect(
      runWithTenant(A, () =>
        Widget.updateOne({ _id: mine?._id }, { $rename: { name: 'propertyId' } }),
      ),
    ).rejects.toBeInstanceOf(TenantMismatchError);
    await expect(
      runWithTenant(A, () =>
        Widget.updateOne({ _id: mine?._id }, { $rename: { propertyId: 'elsewhere' } }),
      ),
    ).rejects.toBeInstanceOf(TenantMismatchError);
    expect((await inPlatform(() => Widget.findById(mine?._id)))?.propertyId?.equals(A)).toBe(true);
  });

  it('lets platform code use pipeline updates', async () => {
    const result = await inPlatform(() =>
      Widget.updateMany({ propertyId: B }, [{ $set: { qty: 77 } }], { updatePipeline: true }),
    );
    expect(result.modifiedCount).toBe(1);
  });
});
