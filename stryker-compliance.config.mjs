/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
/**
 * Stryker config for EU AI Act compliance report engine (N-210 Gate 6).
 * Targets compliance-report.ts — buildEuComplianceReport(), getRemediations(),
 * buildTestCategoryMappings(). First run; Gate 6 threshold: 80%.
 *
 * Run from monorepo root:
 *   npx stryker run stryker-compliance.config.mjs
 */
export default {
  testRunner: 'vitest',
  mutate: [
    // Target the logic core (lines 1–1661).
    // Exclude HTML renderer (1662–1822) and PDF renderer (1823–2115) —
    // these contain CSS color constants and HTML markup string literals
    // that survive legitimately without snapshot tests, inflating survivor
    // count without actionable signal.
    'packages/cli/cli/compliance-report.ts:1-1661',
  ],
  coverageAnalysis: 'off',
  thresholds: { high: 80, low: 60, break: 80 },
  reporters: ['clear-text', 'json'],
  logLevel: 'warn',
  tempDirName: '/tmp/stryker-faultline-compliance',
  testFiles: [
    'packages/cli/tests/compliance-report.test.ts',
    'packages/cli/tests/compliance-report-hardening.test.ts',
    'packages/cli/tests/compliance-report-hardening-2.test.ts',
    'packages/cli/tests/compliance-report-hardening-3.test.ts',
    'packages/cli/tests/compliance-report-hardening-4.test.ts',
    'packages/cli/tests/compliance-report-hardening-5.test.ts',
    'packages/cli/tests/compliance-report-hardening-6.test.ts',
    'packages/cli/tests/compliance-report-hardening-7.test.ts',
  ],
  vitest: {
    dir: 'packages/cli',
    related: false,
  },
};
