import mongoose, { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { twoTenants, useTestDatabase } from '../../../test/db';
import { runAsPlatform, runWithContext, runWithTenant } from '../request-context';
import { TenantContextError } from '../tenant-plugin';
import { recordAudit } from './audit';
import { AuditImmutableError, AuditLog } from './audit-log.model';

useTestDatabase();

const { a: A, b: B } = twoTenants();

beforeAll(async () => {
  await AuditLog.init();
});

const manager = { kind: 'staff', id: 'staff-9', role: 'manager' } as const;

describe('recordAudit', () => {
  it('stores who did what to which record, from the request context', async () => {
    const targetId = new Types.ObjectId().toString();
    await runWithContext(
      { requestId: 'req-42', ip: '203.0.113.7', propertyId: A, principal: manager },
      () =>
        recordAudit({
          action: 'staff.role_changed',
          target: { type: 'staff', id: targetId },
          summary: { from: 'front_desk', to: 'manager' },
        }),
    );

    const [entry] = await runWithTenant(A, () => AuditLog.find({ 'target.id': targetId }));
    expect(entry?.action).toBe('staff.role_changed');
    expect(entry?.actor).toMatchObject({ kind: 'staff', id: 'staff-9', role: 'manager' });
    expect(entry?.target).toMatchObject({ type: 'staff', id: targetId });
    expect(entry?.summary).toEqual({ from: 'front_desk', to: 'manager' });
    expect(entry?.requestId).toBe('req-42');
    expect(entry?.ip).toBe('203.0.113.7');
    expect(entry?.propertyId.equals(A)).toBe(true);
    expect(entry?.at).toBeInstanceOf(Date);
  });

  it('records a system actor when there is no signed-in principal', async () => {
    await runWithTenant(A, () =>
      recordAudit({ action: 'job.ran', target: { type: 'job', id: 'j-1' } }),
    );
    const entry = await runWithTenant(A, () => AuditLog.findOne({ 'target.id': 'j-1' }));
    expect(entry?.actor.kind).toBe('system');
  });

  it('keeps each property audit trail private', async () => {
    await runWithTenant(A, () =>
      recordAudit({ action: 'only.a', target: { type: 'x', id: 'iso-1' } }),
    );
    expect(await runWithTenant(B, () => AuditLog.find({ 'target.id': 'iso-1' }))).toEqual([]);
  });

  it('can join the surrounding transaction', async () => {
    await expect(
      runWithTenant(A, () =>
        mongoose.connection.transaction(async (session) => {
          await recordAudit({
            action: 'tx.test',
            target: { type: 'x', id: 'tx-1' },
            session,
          });
          throw new Error('rollback');
        }),
      ),
    ).rejects.toThrow('rollback');
    expect(await runWithTenant(A, () => AuditLog.find({ 'target.id': 'tx-1' }))).toEqual([]);
  });

  it('needs an explicit propertyId in platform mode', async () => {
    await expect(
      runAsPlatform(() => recordAudit({ action: 'p.test', target: { type: 'x', id: 'p-1' } })),
    ).rejects.toThrow(/propertyId/);

    await runAsPlatform(() =>
      recordAudit({ action: 'p.test', target: { type: 'x', id: 'p-2' }, propertyId: B }),
    );
    const entry = await runWithTenant(B, () => AuditLog.findOne({ 'target.id': 'p-2' }));
    expect(entry?.propertyId.equals(B)).toBe(true);
  });

  it('refuses to run with no context at all', async () => {
    await expect(
      recordAudit({ action: 'no.ctx', target: { type: 'x', id: 'n-1' } }),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe('audit log is append-only', () => {
  async function seedOne(): Promise<Types.ObjectId> {
    await runWithTenant(A, () =>
      recordAudit({ action: 'seed', target: { type: 'x', id: 'immutable-1' } }),
    );
    const entry = await runWithTenant(A, () => AuditLog.findOne({ 'target.id': 'immutable-1' }));
    return entry?._id as Types.ObjectId;
  }

  it('rejects updates', async () => {
    const id = await seedOne();
    await expect(
      runWithTenant(A, () => AuditLog.updateOne({ _id: id }, { action: 'tampered' })),
    ).rejects.toBeInstanceOf(AuditImmutableError);
    await expect(
      runWithTenant(A, () => AuditLog.findOneAndUpdate({ _id: id }, { action: 'tampered' })),
    ).rejects.toBeInstanceOf(AuditImmutableError);
    await expect(
      runWithTenant(A, () => AuditLog.updateMany({}, { action: 'tampered' })),
    ).rejects.toBeInstanceOf(AuditImmutableError);
  });

  it('rejects deletes', async () => {
    const id = await seedOne();
    await expect(runWithTenant(A, () => AuditLog.deleteOne({ _id: id }))).rejects.toBeInstanceOf(
      AuditImmutableError,
    );
    await expect(runWithTenant(A, () => AuditLog.deleteMany({}))).rejects.toBeInstanceOf(
      AuditImmutableError,
    );
    await expect(
      runWithTenant(A, () => AuditLog.findOneAndDelete({ _id: id })),
    ).rejects.toBeInstanceOf(AuditImmutableError);
  });

  it('rejects editing and re-saving an existing entry', async () => {
    const id = await seedOne();
    const entry = await runWithTenant(A, () => AuditLog.findById(id));
    expect(entry).not.toBeNull();
    if (!entry) return;
    entry.action = 'tampered';
    await expect(runWithTenant(A, () => entry.save())).rejects.toBeInstanceOf(AuditImmutableError);
    await expect(runWithTenant(A, () => entry.deleteOne())).rejects.toBeInstanceOf(
      AuditImmutableError,
    );
  });
});
