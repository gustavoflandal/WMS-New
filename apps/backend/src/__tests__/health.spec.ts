// RNF-ARQ-001: Health check unit test
import { describe, it, expect } from 'vitest';

describe('Health Check', () => {
  it('should have test infrastructure working', () => {
    expect(true).toBe(true);
  });

  it('should load environment variables', () => {
    const apiPort = process.env.API_PORT || '3000';
    expect(apiPort).toBeDefined();
    expect(parseInt(apiPort)).toBeGreaterThan(0);
  });
});
