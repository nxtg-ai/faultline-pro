/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
/**
 * Root-level Stryker config for the SSE scan streaming route.
 * Run from monorepo root so the sandbox's node_modules symlink
 * resolves to the root node_modules (which has all packages).
 *
 * Targets the SSE streaming route (N-134/N-135):
 *   - packages/api/src/routes/stream.ts
 */
export default {
  testRunner: 'vitest',
  mutate: [
    'packages/api/src/routes/stream.ts',
  ],
  coverageAnalysis: 'all',
  thresholds: { high: 80, low: 60, break: 0 },
  reporters: ['clear-text'],
  logLevel: 'warn',
  tempDirName: '/tmp/stryker-faultline-stream',
  testFiles: [
    'packages/api/tests/scan-stream.test.ts',
    'packages/api/tests/scan-progressive-stream.test.ts',
    'packages/api/tests/stream-route-mutation-hardening.test.ts',
    'packages/api/tests/scan-stream-post.test.ts',
  ],
  vitest: {
    dir: 'packages/api',
    related: false,
  },
};
