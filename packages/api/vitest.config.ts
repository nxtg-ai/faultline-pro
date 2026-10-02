import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    exclude: ['**/node_modules/**', '**/.stryker-tmp/**', '**/dist/**'],
    // Existing suites use fake hosts and loopback servers with mocked fetch. The
    // outbound URL guard honours this only under a test runner; the guard's own
    // tests delete it to exercise the real checks.
    env: { FAULTLINE_OUTBOUND_ALLOW_PRIVATE: '1' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/graphql/schema.ts', 'node_modules', 'dist'],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
      },
    },
  },
});
