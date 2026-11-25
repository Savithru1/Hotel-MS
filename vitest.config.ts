import { defineConfig } from 'vitest/config';

// Root-level tests only (repository structure and scope rules).
// Each workspace package runs its own tests with its own `vitest run`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
