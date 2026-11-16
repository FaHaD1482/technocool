import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Tests that need a real database (calculation vs SQL views, own-BOQ rule, locking, export).
 * They are destructive: the guard in src/test/setup-db.ts requires TEST_DATABASE_URL pointing at a *_test
 * database, and refuses to run against DATABASE_URL.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      'server-only': path.resolve(import.meta.dirname, 'src/test/server-only-stub.ts'),
    },
  },
  test: {
    include: ['src/**/*.db.test.ts'],
    globalSetup: ['src/test/setup-db.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
