/**
 * managed-cost-event.test.ts — BLG-005 phase-2: buildManagedCostEvent().
 *
 * Proves the cost event uses REAL composed usage when the scan captured legs,
 * and falls back to the legacy text-length estimate ONLY when nothing was
 * captured (mock/offline/cache/all-error) — never silently emitting $0.
 *
 * Validates: BLG-CLX9-20260703-005 (real usage replaces the estimate)
 */
import { describe, it, expect } from 'vitest';
import { buildManagedCostEvent, computeScanCost } from '../src/store/costs.js';
import type { UsageLeg } from '../src/store/consensus-cost.js';

const opts = {
  text: 'a'.repeat(400),
  provider: 'openai',
  claimCount: 5,
  tier: 'pro' as const,
  latencyMs: 123,
};

describe('buildManagedCostEvent', () => {
  it('MCE-01: legs present → REAL composed cost + summed tokens + primary model', () => {
    const legs: UsageLeg[] = [
      { model: 'gpt-4o', callType: 'web_search', inputTokens: 1_000_000, outputTokens: 0, isGrounding: true },   // $2.50 + $0.010
      { model: 'claude-opus-4-8', callType: 'grounded-verify:claude', inputTokens: 0, outputTokens: 100_000, isGrounding: false }, // $2.50
    ];
    const ev = buildManagedCostEvent(legs, opts);
    // 1M input × $2.50/M + $0.010 grounding + 100k output × $25/M = 2.50 + 0.010 + 2.50
    expect(ev.costUsd).toBeCloseTo(5.01, 6);
    expect(ev.inputTokens).toBe(1_000_000);
    expect(ev.outputTokens).toBe(100_000);
    expect(ev.groundingCalls).toBe(1);
    // primaryModel = highest-cost leg (gpt-4o $2.51 vs opus $2.50)
    expect(ev.modelId).toBe('gpt-4o');
    // NOT the legacy text-length estimate
    expect(ev.costUsd).not.toBeCloseTo(computeScanCost(100, 30, 5, 'openai'), 6);
  });

  it('MCE-02: no legs → HONEST fallback to legacy estimate (never silent $0)', () => {
    const ev = buildManagedCostEvent([], opts);
    const estInput = Math.ceil(opts.text.length / 4); // 100
    const estOutput = Math.ceil(estInput * 0.3);       // 30
    expect(ev.inputTokens).toBe(estInput);
    expect(ev.outputTokens).toBe(estOutput);
    expect(ev.groundingCalls).toBe(opts.claimCount);
    expect(ev.costUsd).toBeCloseTo(computeScanCost(estInput, estOutput, opts.claimCount, 'openai'), 10);
    expect(ev.costUsd).toBeGreaterThan(0);
    // fallback model label is the provider default, not a real captured model
    expect(ev.modelId).toBe('gpt-4o-mini');
  });

  it('MCE-03: real claude leg is priced opus, not the legacy haiku table', () => {
    const legs: UsageLeg[] = [
      { model: 'claude-opus-4-8', callType: 'grounded-verify:claude', inputTokens: 10_000, outputTokens: 10_000, isGrounding: false },
    ];
    const ev = buildManagedCostEvent(legs, { ...opts, provider: 'claude' });
    // opus: 10k×$5/M + 10k×$25/M = 0.05 + 0.25 = 0.30
    expect(ev.costUsd).toBeCloseTo(0.30, 6);
    // haiku (old MANAGED_PROVIDER_RATES.claude) would be 10k×0.80/M + 10k×4/M = 0.048 → 6.25× less
    expect(ev.costUsd).not.toBeCloseTo(0.048, 4);
  });
});
