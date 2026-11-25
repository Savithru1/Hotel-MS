import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  bindPrincipal,
  getContext,
  getTenantId,
  runAsPlatform,
  runWithContext,
  runWithTenant,
} from './request-context';

describe('request context', () => {
  it('has no context outside a run', () => {
    expect(getContext()).toBeUndefined();
  });

  it('exposes the tenant inside runWithTenant and nowhere else', () => {
    const id = new Types.ObjectId();
    runWithTenant(id, () => {
      expect(getTenantId()?.equals(id)).toBe(true);
    });
    expect(getTenantId()).toBeUndefined();
  });

  it('keeps the context across awaits and timers', async () => {
    const id = new Types.ObjectId();
    await runWithTenant(id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await Promise.resolve();
      expect(getTenantId()?.equals(id)).toBe(true);
    });
  });

  it('keeps concurrent requests apart', async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    const seen = await Promise.all([
      runWithTenant(a, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return getTenantId();
      }),
      runWithTenant(b, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getTenantId();
      }),
    ]);
    expect(seen[0]?.equals(a)).toBe(true);
    expect(seen[1]?.equals(b)).toBe(true);
  });

  it('marks platform mode explicitly and carries no tenant in it', () => {
    runAsPlatform(() => {
      expect(getContext()?.platform).toBe(true);
      expect(getTenantId()).toBeUndefined();
    });
  });

  it('lets later middleware bind the authenticated principal and tenant to the request', () => {
    const id = new Types.ObjectId();
    runWithContext({ requestId: 'req-1' }, () => {
      expect(getTenantId()).toBeUndefined();
      bindPrincipal({ kind: 'staff', id: 'u1', role: 'manager' }, id);
      expect(getTenantId()?.equals(id)).toBe(true);
      expect(getContext()?.principal).toEqual({ kind: 'staff', id: 'u1', role: 'manager' });
      expect(getContext()?.requestId).toBe('req-1');
    });
  });

  it('refuses to bind a principal when there is no request context', () => {
    expect(() => bindPrincipal({ kind: 'staff', id: 'u1' }, new Types.ObjectId())).toThrow(
      /context/i,
    );
  });

  it('does not leak a bound principal into a sibling request', () => {
    runWithContext({ requestId: 'one' }, () => {
      bindPrincipal({ kind: 'staff', id: 'u1' }, new Types.ObjectId());
    });
    runWithContext({ requestId: 'two' }, () => {
      expect(getContext()?.principal).toBeUndefined();
      expect(getTenantId()).toBeUndefined();
    });
  });
});
