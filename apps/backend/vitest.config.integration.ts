// RNF-ARQ-001: Integration test configuration (requires Docker services)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    exclude: ['node_modules', 'dist'],
    globalSetup: ['./test-setup.ts'],
    testTimeout: 30000,
    // Integration test files share ONE Postgres/Redis instance and mutate
    // global state (schema reset, redisClient.flushDb(), shared streams) —
    // running files in parallel races them against each other (e.g. a
    // flushDb() in one file wiping a consumer group another file just set up).
    fileParallelism: false,
  },
});
