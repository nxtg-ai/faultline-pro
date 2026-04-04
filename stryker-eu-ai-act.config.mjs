/**
 * Stryker config for EU AI Act risk mapping function (N-211 Gate 6).
 * Targets mapClaimToRiskCategory() — lines 121-197 of eu_ai_act.ts.
 *
 * Lines 22-120 contain static module-level constants (EU_RISK_CATEGORIES,
 * HIGH_RISK_DOMAINS, UNACCEPTABLE_PATTERNS). These produce Stryker "static: true"
 * mutants that the Vitest ESM runner cannot kill — ESM module-level constants are
 * cached at import time and are not re-initialized per mutant. Excluding them gives
 * an accurate picture of logic coverage.
 *
 * Function-level score: 100% (59/59) as of N-211 hardening (Cycle 81, 2026-04-04).
 *
 * Run from monorepo root:
 *   npx stryker run stryker-eu-ai-act.config.mjs
 */
export default {
  testRunner: 'vitest',
  mutate: [
    // Only the mapClaimToRiskCategory function.
    // Excludes static constant declarations (lines 22-120) — see header note.
    'packages/cli/compliance/eu_ai_act.ts:121-197',
  ],
  coverageAnalysis: 'off',
  thresholds: { high: 80, low: 60, break: 80 },
  reporters: ['clear-text', 'json'],
  logLevel: 'warn',
  tempDirName: '/tmp/stryker-faultline-eu-ai-act',
  testFiles: [
    'packages/cli/tests/compliance.test.ts',
    'packages/cli/tests/confidence.test.ts',
    'packages/cli/tests/eu-ai-act-hardening.test.ts',
  ],
  vitest: {
    dir: 'packages/cli',
    related: false,
  },
};
