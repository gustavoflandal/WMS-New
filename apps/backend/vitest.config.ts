// RNF-ARQ-001: Test configuration for unit vs integration tests
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration tests marked with .integration.spec.ts
    // Unit tests marked with .spec.ts
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist', '**/node_modules/**', '**/*.integration.spec.ts'],
    setupFiles: ['./test-setup.ts'],
    testTimeout: 30000,
  },
});
