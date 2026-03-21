/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
/**
 * Root-level Stryker config for API GDPR store cluster.
 * Run from monorepo root so the sandbox's node_modules symlink
 * resolves to the root node_modules (which has all packages).
 *
 * Targets the three GDPR-critical delete/filter stores:
 *   - packages/api/src/store/costs.ts
 *   - packages/api/src/store/schedules.ts
 *   - packages/api/src/store/notifications.ts
 */
export default {
  testRunner: 'vitest',
  mutate: [
    'packages/api/src/store/costs.ts',
    'packages/api/src/store/schedules.ts',
    'packages/api/src/store/notifications.ts',
  ],
  coverageAnalysis: 'off',
  thresholds: { high: 80, low: 60, break: 0 },
  reporters: ['clear-text'],
  logLevel: 'warn',
  tempDirName: '/tmp/stryker-faultline-gdpr',
  testFiles: [
    'packages/api/tests/costs.test.ts',
    'packages/api/tests/gdpr-costs.test.ts',
    'packages/api/tests/gdpr-schedules.test.ts',
    'packages/api/tests/schedules.test.ts',
    'packages/api/tests/notifications.test.ts',
    'packages/api/tests/gdpr-erasure-prefs.test.ts',
    'packages/api/tests/gdpr-erasure.test.ts',
    'packages/api/tests/gdpr-export.test.ts',
    'packages/api/tests/gdpr-store-mutation-hardening.test.ts',
    'packages/api/tests/schedule-runner-mutation-hardening.test.ts',
    'packages/api/tests/schedule-store-mutation-hardening.test.ts',
    'packages/api/tests/notification-dispatch-mutation-hardening.test.ts',
    'packages/api/tests/schedule-notification-event-type.test.ts',
    'packages/api/tests/costs-aggregate-hardening.test.ts',
  ],
  vitest: {
    dir: 'packages/api',
    related: false,
  },
};
