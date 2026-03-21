/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  mutate: [
    'src/store/webhooks.ts',
  ],
  coverageAnalysis: 'off',
  thresholds: { high: 80, low: 60, break: 0 },
  reporters: ['clear-text'],
  logLevel: 'warn',
  // Keep temp sandbox outside the package so vitest doesn't pick it up
  tempDirName: '/tmp/stryker-faultline-api',
};
