// ABOUTME: Vitest configuration for testing.
// ABOUTME: Sets up test environment with dotenv support.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts', 'dotenv/config'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Run tests sequentially to avoid database conflicts
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    // Restore vi.stubEnv() values between tests. Without this, an API_KEY stub
    // in one file leaks into later files (shared process under fileParallelism:
    // false), intermittently flipping auth-gated tests from 400 to 401.
    unstubEnvs: true,
  },
});
