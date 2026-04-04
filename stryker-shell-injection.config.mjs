/**
 * Stryker mutation config for shell_injection_rule.ts — N-213
 *
 * Targets only the check() function body (lines 100-208).
 * Lines 1-99 are static constant maps (ZERO_WIDTH, BIDI_OVERRIDES, etc.) —
 * excluded because ESM module-level constants are cached at import time and
 * Stryker cannot reinitialize them per mutant (same limitation as eu_ai_act.ts).
 *
 * @see docs/mutation-testing.md — "Cannot kill — ESM module-level static constants"
 */
export default {
  testRunner: 'vitest',
  mutate: ['packages/cli/rules/shell_injection_rule.ts:100-208'],
  coverageAnalysis: 'off',
  thresholds: { high: 80, low: 60, break: 80 },
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/shell-injection.json' },
  logLevel: 'warn',
  testFiles: [
    'packages/cli/tests/rules.test.ts',
    'packages/cli/tests/shell-injection-hardening.test.ts',
  ],
  vitest: { dir: 'packages/cli', related: false },
};
