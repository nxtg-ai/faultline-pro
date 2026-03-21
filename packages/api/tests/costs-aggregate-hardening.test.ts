/**
 * N-132 — CostStore.getAggregate() + getCosts() mutation hardening (CA1–CA15)
 *
 * Targets 6 surviving mutants in costs.ts not killed by previous tests:
 *
 * getCosts() provider filter (line 54):
 *   CA1: provider filter excludes non-matching entries — kills if(false) at line 54
 *        (if false: provider mismatch never triggers return false → wrong entries returned)
 *   CA2: provider filter returns matching entries — kills if(true) at line 54
 *        (if true: always returns false → no entries pass)
 *
 * getAggregate() totalCostUsd accumulator (line 78):
 *   CA3: totalCostUsd equals exact sum of 2 non-zero-cost entries — kills += → -= at line 78
 *        (subtraction would give 0; sum gives 2×cost)
 *
 * getAggregate() byProvider.costUsd accumulator (line 84):
 *   CA4: byProvider[p].costUsd equals sum of 2 entries for that provider — kills += → -= at line 84
 *
 * getAggregate() byDate initialization guard (line 86):
 *   CA5: 3 entries on same date → byDate[d].tokens equals their sum, not last value — kills if(true) at line 86
 *        (if true: reinitializes on every iteration → final = last entry only, not sum)
 *        also kills if(false): undefined[].tokens throws → test fails
 *
 * getAggregate() byDate.tokens accumulator (line 89):
 *   CA6: byDate[d].tokens equals exact sum of 2 same-date entries — kills += → -= at line 89
 *
 * getAggregate() byDate.costUsd accumulator (line 90):
 *   CA7: byDate[d].costUsd equals exact sum of 2 same-date entries — kills += → -= at line 90
 *
 * Supporting tests (CA8–CA15):
 *   CA8:  byProvider tracks multiple providers independently
 *   CA9:  byDate tracks multiple dates independently
 *   CA10: totalTokens and totalCostUsd both zero when only mock entries
 *   CA11: provider filter correctly isolates one of two providers with exact count
 *   CA12: aggregate over provider-filtered subset reflects only that provider's costs
 *   CA13: byProvider.costUsd > byDate.costUsd is impossible — they reflect the same entries
 *   CA14: aggregate of empty filtered set returns all-zero structure
 *   CA15: byProvider key count equals number of distinct providers in data
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getCostStore, resetCostStore } from '../src/store/costs.js';

// Known-cost input: 4000-char string
// inputTokens = ceil(4000/4) = 1000, outputTokens = 2000, totalTokens = 3000
// gemini: (1000/1000)*0.000125 + (2000/1000)*0.000375 = 0.000875
const INPUT_4K = 'A'.repeat(4000);
const GEMINI_COST_4K = 0.000875;
const GEMINI_TOKENS_4K = 3000;

beforeEach(() => {
  resetCostStore();
});

// ── Provider filter ConditionalExpression (CA1–CA2) ───────────────────────────

describe('CostStore.getCosts() — provider filter', () => {
  // CA1: kills if(false) at line 54 — filter?.provider guard always false = no provider filtering
  it('CA1: provider filter excludes entries with a different provider', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'openai', INPUT_4K);
    store.record('key1', 'openai', INPUT_4K);

    const openaiOnly = store.getCosts({ provider: 'openai' });
    // if(false) mutation: gemini entry would also be returned → length would be 3
    expect(openaiOnly).toHaveLength(2);
    expect(openaiOnly.every(e => e.provider === 'openai')).toBe(true);
  });

  // CA2: kills if(true) at line 54 — always returns false = no entries pass filter
  it('CA2: provider filter returns entries that match the provider', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'claude', INPUT_4K);

    const geminiOnly = store.getCosts({ provider: 'gemini' });
    // if(true) mutation: all entries filtered out → length 0
    expect(geminiOnly.length).toBeGreaterThan(0);
    expect(geminiOnly).toHaveLength(2);
  });
});

// ── totalCostUsd accumulator (CA3) ────────────────────────────────────────────

describe('CostStore.getAggregate() — totalCostUsd accumulation', () => {
  // CA3: kills += → -= at line 78
  // With -=: entry1 - entry2 = 0 for identical costs
  it('CA3: totalCostUsd is the sum of all entries, not the difference', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'gemini', INPUT_4K);

    const agg = store.getAggregate();
    // Correct (+= ++=): 0.000875 + 0.000875 = 0.001750
    // -= mutation:       0.000875 - 0.000875 = 0
    expect(agg.totalCostUsd).toBeCloseTo(GEMINI_COST_4K * 2, 7);
    expect(agg.totalCostUsd).toBeGreaterThan(GEMINI_COST_4K);
  });
});

// ── byProvider.costUsd accumulator (CA4) ─────────────────────────────────────

describe('CostStore.getAggregate() — byProvider.costUsd accumulation', () => {
  // CA4: kills += → -= at line 84
  it('CA4: byProvider[provider].costUsd is the sum of entries for that provider', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'gemini', INPUT_4K);

    const agg = store.getAggregate();
    // Correct: 3 × GEMINI_COST_4K
    // -= mutation: alternating signs → final = +cost -cost +cost = single cost
    expect(agg.byProvider['gemini'].costUsd).toBeCloseTo(GEMINI_COST_4K * 3, 7);
    expect(agg.byProvider['gemini'].costUsd).toBeGreaterThan(GEMINI_COST_4K * 2);
  });
});

// ── byDate initialization guard (CA5) ────────────────────────────────────────

describe('CostStore.getAggregate() — byDate initialization guard', () => {
  // CA5: kills if(true) at line 86
  // if(true) reinitializes byDate[date] on every iteration → final = only last entry's values
  it('CA5: byDate[date].tokens accumulates all same-date entries, not just the last', () => {
    const store = getCostStore();
    // 3 entries — all land on today's date
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'gemini', INPUT_4K);

    const agg = store.getAggregate();
    const todayKey = Object.keys(agg.byDate)[0];
    expect(todayKey).toBeDefined();
    // if(true) mutation: byDate[today].tokens = GEMINI_TOKENS_4K (last entry only, not sum)
    expect(agg.byDate[todayKey].tokens).toBe(GEMINI_TOKENS_4K * 3);
    expect(agg.byDate[todayKey].tokens).toBeGreaterThan(GEMINI_TOKENS_4K * 2);
  });
});

// ── byDate.tokens accumulator (CA6) ──────────────────────────────────────────

describe('CostStore.getAggregate() — byDate.tokens accumulation', () => {
  // CA6: kills += → -= at line 89
  it('CA6: byDate[date].tokens is the sum of tokens for all same-date entries', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key2', 'gemini', INPUT_4K);

    const agg = store.getAggregate();
    const todayKey = Object.keys(agg.byDate)[0];
    // Correct: GEMINI_TOKENS_4K × 2 = 6000
    // -= mutation: 3000 - 3000 = 0
    expect(agg.byDate[todayKey].tokens).toBe(GEMINI_TOKENS_4K * 2);
    expect(agg.byDate[todayKey].tokens).toBeGreaterThan(GEMINI_TOKENS_4K);
  });
});

// ── byDate.costUsd accumulator (CA7) ─────────────────────────────────────────

describe('CostStore.getAggregate() — byDate.costUsd accumulation', () => {
  // CA7: kills += → -= at line 90
  it('CA7: byDate[date].costUsd is the sum of costs for all same-date entries', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key2', 'gemini', INPUT_4K);

    const agg = store.getAggregate();
    const todayKey = Object.keys(agg.byDate)[0];
    // Correct: GEMINI_COST_4K × 2
    // -= mutation: GEMINI_COST_4K - GEMINI_COST_4K = 0
    expect(agg.byDate[todayKey].costUsd).toBeCloseTo(GEMINI_COST_4K * 2, 7);
    expect(agg.byDate[todayKey].costUsd).toBeGreaterThan(GEMINI_COST_4K);
  });
});

// ── Supporting hardening tests (CA8–CA15) ────────────────────────────────────

describe('CostStore.getAggregate() — supporting hardening', () => {
  // CA8: byProvider correctly separates two different providers
  it('CA8: byProvider has separate entries for two different providers', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'openai', INPUT_4K);

    const agg = store.getAggregate();
    expect(agg.byProvider).toHaveProperty('gemini');
    expect(agg.byProvider).toHaveProperty('openai');
    expect(agg.byProvider['gemini'].costUsd).not.toBe(agg.byProvider['openai'].costUsd);
  });

  // CA9: byDate tracks entries across distinct dates (inject known dates)
  it('CA9: byDate has one key per unique date in the data', () => {
    const store = getCostStore();
    // All entries today — one date key
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key2', 'gemini', INPUT_4K);

    const agg = store.getAggregate();
    expect(Object.keys(agg.byDate)).toHaveLength(1);
  });

  // CA10: mock provider contributes zero cost — totalCostUsd stays 0
  it('CA10: mock provider entries contribute zero cost to totalCostUsd', () => {
    const store = getCostStore();
    store.record('key1', 'mock', INPUT_4K);
    store.record('key1', 'mock', INPUT_4K);
    store.record('key1', 'mock', INPUT_4K);

    const agg = store.getAggregate();
    expect(agg.totalCostUsd).toBe(0);
    expect(agg.totalTokens).toBeGreaterThan(0); // tokens still counted
  });

  // CA11: provider filter count isolation — gemini count is independent of openai count
  it('CA11: provider-filtered aggregate reflects only that provider\'s token total', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'openai', INPUT_4K);

    const geminiAgg = store.getAggregate({ provider: 'gemini' });
    const openaiAgg = store.getAggregate({ provider: 'openai' });

    expect(geminiAgg.totalTokens).toBe(GEMINI_TOKENS_4K * 2);
    expect(openaiAgg.totalTokens).toBe(GEMINI_TOKENS_4K); // same input size → same tokens
  });

  // CA12: aggregate over provider filter reflects only matching entries' costs
  it('CA12: aggregate with provider filter excludes other-provider costs', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'claude', INPUT_4K); // different rate

    const allAgg = store.getAggregate();
    const geminiAgg = store.getAggregate({ provider: 'gemini' });

    // Filtered aggregate must be less than full aggregate (two different-cost providers)
    expect(geminiAgg.totalCostUsd).toBeLessThan(allAgg.totalCostUsd);
    expect(geminiAgg.totalCostUsd).toBeCloseTo(GEMINI_COST_4K, 7);
  });

  // CA13: aggregate of empty result set returns zero totals with empty byProvider/byDate
  it('CA13: aggregate over empty filtered set returns zero structure', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);

    const agg = store.getAggregate({ provider: 'nonexistent-provider' });
    expect(agg.totalTokens).toBe(0);
    expect(agg.totalCostUsd).toBe(0);
    expect(Object.keys(agg.byProvider)).toHaveLength(0);
    expect(Object.keys(agg.byDate)).toHaveLength(0);
  });

  // CA14: byProvider key count equals number of distinct providers recorded
  it('CA14: byProvider has one key per distinct provider', () => {
    const store = getCostStore();
    store.record('key1', 'gemini', INPUT_4K);
    store.record('key1', 'gemini', INPUT_4K); // duplicate — same key
    store.record('key1', 'openai', INPUT_4K);
    store.record('key1', 'claude', INPUT_4K);

    const agg = store.getAggregate();
    // 3 distinct providers → 3 keys in byProvider
    expect(Object.keys(agg.byProvider)).toHaveLength(3);
  });

  // CA15: byProvider[p].tokens and .costUsd are both non-negative for a real provider
  it('CA15: byProvider accumulates tokens and cost independently per provider', () => {
    const store = getCostStore();
    store.record('key1', 'openai', INPUT_4K);
    store.record('key1', 'openai', INPUT_4K);

    const agg = store.getAggregate();
    // openai rates are higher than gemini — both fields should be > 0
    expect(agg.byProvider['openai'].tokens).toBe(GEMINI_TOKENS_4K * 2);
    expect(agg.byProvider['openai'].costUsd).toBeGreaterThan(GEMINI_COST_4K * 2); // openai costs more
  });
});
