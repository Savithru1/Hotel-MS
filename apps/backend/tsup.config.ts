import { defineConfig } from 'tsup';

// Production build: one bundled ESM file. Workspace packages are shipped as TypeScript source,
// so they are bundled in; third-party dependencies stay external and come from node_modules.
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@hospitality\//],
});
