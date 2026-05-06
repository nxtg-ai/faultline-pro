/**
 * DIRECTIVE-NXTG-20260506-04 — Managed-key scan cost telemetry
 * N-227 (scan_cost event instrumentation)
 *
 * SC-01 … SC-08: computeScanCost() unit tests
 * SC-09 … SC-12: CostStore.getPercentiles() unit tests
 * SC-13 … SC-14: renderCostStats() smoke tests
 *
 * Validates: N-227 (DIRECTIVE-NXTG-20260506-04 DoD — cost calculation function ≥3 unit tests)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { computeScanCost, getCostStore, resetCostStore, type ManagedScanCostEvent } from '../src/store/costs.js';
import { renderCostStats } from '../../cli/cli/stats.js';

// ── computeScanCost unit tests ────────────────────────────────────────────────

describe('computeScanCost()', () => {
  it('SC-01: all-zero inputs → cost is 0', () => {
    expect(computeScanCost(0, 0, 0, 'gemini')).toBe(0);
  });

  it('SC-02: zero output tokens — only input cost applies', () => {
    // gemini: $0.15 / 1M input = $0.00000015 per token
    const cost = computeScanCost(1_000_000, 0, 0, 'gemini');
    expect(cost).toBeCloseTo(0.15, 6);
  });

  it('SC-03: grounding=0 — no grounding surcharge', () => {
    const withGrounding = computeScanCost(1000, 300, 8, 'gemini');
    const withoutGrounding = computeScanCost(1000, 300, 0, 'gemini');
    expect(withGrounding).toBeGreaterThan(withoutGrounding);
    expect(withGrounding - withoutGrounding).toBeCloseTo(8 * 0.035, 6);
  });

  it('SC-04: grounding=8 — surcharge is 8 * $0.035 for gemini', () => {
    const baseCost = computeScanCost(1000, 300, 0, 'gemini');
    const cost8 = computeScanCost(1000, 300, 8, 'gemini');
    expect(cost8 - baseCost).toBeCloseTo(0.28, 6);
  });

  it('SC-05: mock provider → cost is always 0 regardless of tokens', () => {
    expect(computeScanCost(100_000, 30_000, 10, 'mock')).toBe(0);
  });

  it('SC-06: unknown provider → cost is 0 (safe default)', () => {
    expect(computeScanCost(1000, 300, 0, 'unknown-provider')).toBe(0);
  });

  it('SC-07: claude rates — higher output rate than gemini', () => {
    // claude: $4.00/M output vs gemini $0.60/M output
    const claude = computeScanCost(0, 1_000_000, 0, 'claude');
    const gemini = computeScanCost(0, 1_000_000, 0, 'gemini');
    expect(claude).toBeCloseTo(4.0, 4);
    expect(gemini).toBeCloseTo(0.6, 4);
    expect(claude).toBeGreaterThan(gemini);
  });

  it('SC-08: openai and gemini have same rates per directive spec', () => {
    const openai = computeScanCost(500_000, 150_000, 0, 'openai');
    const gemini = computeScanCost(500_000, 150_000, 0, 'gemini');
    expect(openai).toBeCloseTo(gemini, 8);
  });
});

// ── CostStore.getPercentiles() unit tests ─────────────────────────────────────

function makeEvent(costUsd: number, daysAgo = 0): ManagedScanCostEvent {
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return {
    scanId: `scan-${Math.random()}`,
    ts,
    tier: 'personal',
    keyMode: 'managed',
    provider: 'gemini',
    inputTokens: 1000,
    outputTokens: 300,
    groundingCalls: 0,
    costUsd,
    latencyMs: 500,
  };
}

describe('CostStore.getPercentiles()', () => {
  beforeEach(() => resetCostStore());

  it('SC-09: empty store → all percentiles are 0, count is 0', () => {
    const result = getCostStore().getPercentiles(30);
    expect(result.p50).toBe(0);
    expect(result.p90).toBe(0);
    expect(result.p99).toBe(0);
    expect(result.count).toBe(0);
  });

  it('SC-10: single event → p50/p90/p99 all equal that event cost', () => {
    getCostStore().recordManaged(makeEvent(0.001234));
    const result = getCostStore().getPercentiles(30);
    expect(result.p50).toBeCloseTo(0.001234, 8);
    expect(result.p90).toBeCloseTo(0.001234, 8);
    expect(result.p99).toBeCloseTo(0.001234, 8);
    expect(result.count).toBe(1);
  });

  it('SC-11: events outside the window are excluded', () => {
    getCostStore().recordManaged(makeEvent(9.99, 40)); // 40 days ago — outside 30-day window
    getCostStore().recordManaged(makeEvent(0.001, 5)); // within window
    const result = getCostStore().getPercentiles(30);
    expect(result.count).toBe(1);
    expect(result.p50).toBeCloseTo(0.001, 6);
  });

  it('SC-12: p90 and p99 are >= p50 for a spread of 10 values', () => {
    for (let i = 1; i <= 10; i++) {
      getCostStore().recordManaged(makeEvent(i * 0.001));
    }
    const result = getCostStore().getPercentiles(30);
    expect(result.count).toBe(10);
    expect(result.p90).toBeGreaterThanOrEqual(result.p50);
    expect(result.p99).toBeGreaterThanOrEqual(result.p90);
  });
});

// ── renderCostStats() smoke tests ─────────────────────────────────────────────

describe('renderCostStats()', () => {
  it('SC-13: renders p50/p90/p99 with dollar signs and count', () => {
    const output = renderCostStats({ p50: 0.000150, p90: 0.000420, p99: 0.001234, count: 47, windowDays: 30 });
    expect(output).toContain('$0.000150');
    expect(output).toContain('$0.000420');
    expect(output).toContain('$0.001234');
    expect(output).toContain('47');
  });

  it('SC-14: zero-count renders without crashing and notes "estimate"', () => {
    const output = renderCostStats({ p50: 0, p90: 0, p99: 0, count: 0, windowDays: 30 });
    expect(output).toContain('estimate');
    expect(output).toContain('$0.000000');
  });
});
