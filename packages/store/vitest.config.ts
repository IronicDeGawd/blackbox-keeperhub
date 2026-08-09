import { defineConfig } from 'vitest/config';

// These suites share one Postgres database and truncate tables between tests,
// so running files in parallel makes them delete each other's fixtures.
export default defineConfig({
  test: {
    fileParallelism: false,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
