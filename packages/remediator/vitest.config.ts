import { defineConfig } from 'vitest/config';

// Shares the one Postgres database with the other integration suites.
export default defineConfig({
  test: {
    fileParallelism: false,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
