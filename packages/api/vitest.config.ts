import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    exclude: ['**/node_modules/**', '**/.stryker-tmp/**', '**/dist/**'],
    // Existing suites use fake hosts and loopback servers with mocked fetch. The
    // outbound URL guard honours this only under a test runner; the guard's own
    // tests delete it to exercise the real checks.
    // Evidence fetching (GoPMO 1.18.11.3 P1b) is off for the suite so a mocked
    // verdict citing a URL never reaches the network; tests/evidence-routes.test.ts
    // turns it on with a stubbed fetch.
    // The keystore is memory-only for the suite (FAULTLINE_KEYSTORE_FILE=off), so
    // parallel test files never share a keystore file; the keystore persistence
    // tests point it at a temp file of their own.
    env: { FAULTLINE_OUTBOUND_ALLOW_PRIVATE: '1', FAULTLINE_EVIDENCE_FETCH: 'off', FAULTLINE_KEYSTORE_FILE: 'off' },
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
