// ABOUTME: Vitest configuration for testing.
// ABOUTME: Sets up test environment with dotenv support.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['dotenv/config'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
