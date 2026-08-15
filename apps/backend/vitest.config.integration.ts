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
  },
});
