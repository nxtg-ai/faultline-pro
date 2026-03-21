/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  mutate: [
    'src/store/webhooks.ts',
  ],
  // 'off' runs all tests for every mutant — slower but reliable
  coverageAnalysis: 'off',
  thresholds: { high: 80, low: 60, break: 0 },
  reporters: ['clear-text'],
  logLevel: 'warn',
};
