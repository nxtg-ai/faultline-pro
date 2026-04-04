import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Minimal vitest config for Stryker mutation testing.
 * Targets only the claim forensics critical path tests.
 * Uses node environment (no jsdom) and no globals for Stryker compatibility.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: [
      'tests/claim-filter.test.ts',
      'tests/sentence-split.test.ts',
      'tests/app-logic.test.ts',
      'tests/integration.test.ts',
      'tests/mock-provider.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/.stryker-tmp/**', '**/dist/**'],
  },
});
