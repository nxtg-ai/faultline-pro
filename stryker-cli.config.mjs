/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
/**
 * Root-level Stryker config for CLI package.
 * Run from monorepo root so the sandbox's node_modules symlink
 * resolves to the root node_modules (which has all packages).
 */
export default {
  testRunner: 'vitest',
  mutate: [
    'packages/cli/cli/scan.ts',
  ],
  coverageAnalysis: 'off',
  thresholds: { high: 80, low: 60, break: 0 },
  reporters: ['clear-text'],
  logLevel: 'warn',
  tempDirName: '/tmp/stryker-faultline-cli-root',
  testFiles: [
    'packages/cli/tests/claim-filter.test.ts',
    'packages/cli/tests/sentence-split.test.ts',
    'packages/cli/tests/mock-provider.test.ts',
    'packages/cli/tests/integration.test.ts',
    'packages/cli/tests/scan-mutation-hardening.test.ts',
  ],
  vitest: {
    dir: 'packages/cli',
    related: false,
  },
};
