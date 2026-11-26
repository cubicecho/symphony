import path from 'node:path';
import { defineConfig } from 'vitest/config';

const alias = [
  // graphql ships no exports map: Vite follows `module` to index.mjs while Node follows `main`
  // to index.js, and the two copies fail each other's instanceof checks.
  { find: /^graphql$/, replacement: path.resolve(import.meta.dirname, './node_modules/graphql/index.js') },
];

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Threads share one process; each file still opens its own in-memory database (tests/db.ts).
    pool: 'threads',
    // Opening and migrating an in-memory PGlite takes seconds, and minutes when node_modules sits on a busy network drive.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    projects: [{ extends: true, test: { name: 'node', environment: 'node', include: ['tests/**/*.test.ts'] } }],
  },
});
