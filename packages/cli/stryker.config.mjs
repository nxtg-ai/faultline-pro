/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  mutate: [
    'cli/scan.ts',
  ],
  coverageAnalysis: 'off',
  thresholds: { high: 80, low: 60, break: 0 },
  reporters: ['clear-text'],
  logLevel: 'warn',
  // Keep temp sandbox outside the package so vitest doesn't pick it up
  tempDirName: '/tmp/stryker-faultline-cli',
  // Explicitly list test files that cover cli/scan.ts pure functions
  testFiles: [
    'tests/claim-filter.test.ts',
    'tests/sentence-split.test.ts',
    'tests/app-logic.test.ts',
    'tests/mock-provider.test.ts',
    'tests/integration.test.ts',
    'tests/aggregate.test.ts',
    'tests/compare.test.ts',
    'tests/cli.test.ts',
  ],
};
