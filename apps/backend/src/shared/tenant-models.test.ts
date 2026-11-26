import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

/**
 * Models that are deliberately not scoped to one property, and why. Everything else must use
 * the tenant plugin, which adds a required `propertyId` and restricts every query to it.
 */
const NOT_TENANT_SCOPED: Record<string, string> = {
  Property: 'is the tenant itself',
  RefreshToken: 'looked up by an unguessable token before any tenant is known; stores propertyId',
};

function modelFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return modelFiles(path);
    return name.endsWith('.model.ts') ? [path] : [];
  });
}

describe('every model is tenant scoped, or is on the reviewed allow-list', () => {
  const root = resolve(__dirname, '..');

  it('finds the models', async () => {
    const files = modelFiles(root);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) await import(pathToFileURL(file).href);
    expect(mongoose.modelNames().length).toBeGreaterThanOrEqual(4);
  });

  it('applies the tenant plugin to every model not on the allow-list', async () => {
    for (const file of modelFiles(root)) await import(pathToFileURL(file).href);

    const unscoped: string[] = [];
    for (const name of mongoose.modelNames()) {
      if (name in NOT_TENANT_SCOPED) continue;
      const path = mongoose.model(name).schema.path('propertyId');
      if (!path || !path.options.required || path.options.immutable !== true) unscoped.push(name);
    }
    expect(unscoped).toEqual([]);
  });

  it('keeps the allow-list honest: every entry is a real model', async () => {
    for (const file of modelFiles(root)) await import(pathToFileURL(file).href);
    for (const name of Object.keys(NOT_TENANT_SCOPED)) {
      expect(mongoose.modelNames(), name).toContain(name);
    }
  });
});
