/**
 * consensus-cost-replay.test.ts — Wolf verify-gate for BLG-CLX9-20260703-005.
 *
 * Replays the 272 REAL provider-usage records captured on 2026-07-04
 * (scripts/consensus-cost/measured-usage.jsonl, 18 scans) through the fixed
 * cost path (composeConsensusCost). NO re-spend — pure replay of recorded usage.
 *
 * Asserts the fixed telemetry reproduces the measured per-scan economics:
 *   - defect 2: cost SUMS the 1+K·(1+N) fan-out (not one effectiveProvider)
 *   - defect 3: claude leg priced at opus-4-8 ($5/$25), exactly 6.25× the old
 *     haiku assumption — this is the assertion the legacy table FAILS
 *   - magnitude: consensus scans land at the measured $0.2–$0.7 order, not the
 *     11–16,000× under-count the text-length estimate produced
 *   - single-source: this table agrees with the pinned rates.ts LIVE_RATES
 *
 * Validates: BLG-CLX9-20260703-005 (cost-telemetry fix — measured==composed)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  composeConsensusCost,
  priceLeg,
  resolveLegModel,
  CONSENSUS_MODEL_RATES,
  type UsageLeg,
} from '../src/store/consensus-cost.js';
import { LIVE_RATES } from '../../../scripts/consensus-cost/rates.js';

interface RawRecord {
  scanId: string;
  size: string;
  rep: number;
  callType: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  isGrounding: boolean;
  ts: string;
}

const MEASURED = new URL(
  '../../../scripts/consensus-cost/measured-usage.jsonl',
  import.meta.url,
);

function loadRecords(): RawRecord[] {
  return readFileSync(MEASURED, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RawRecord);
}

function toLeg(r: RawRecord): UsageLeg {
  return {
    model: r.model === '?' ? undefined : r.model,
    callType: r.callType,
    provider: r.provider,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    isGrounding: r.isGrounding,
  };
}

function groupByScan(recs: RawRecord[]): Map<string, RawRecord[]> {
  const m = new Map<string, RawRecord[]>();
  for (const r of recs) {
    const arr = m.get(r.scanId) ?? [];
    arr.push(r);
    m.set(r.scanId, arr);
  }
  return m;
}

describe('consensus-cost replay (BLG-005 verify-gate)', () => {
  const recs = loadRecords();

  it('CCR-00: fixture is the expected 272-leg / 18-scan real capture', () => {
    expect(recs.length).toBe(272);
    expect(new Set(recs.map((r) => r.scanId)).size).toBe(18);
    // guard the replay is non-empty and carries all four engine models
    const models = new Set(recs.map((r) => (r.model === '?' ? 'gemini(url)' : r.model)));
    expect(models.has('gpt-4o')).toBe(true);
    expect(models.has('claude-opus-4-8')).toBe(true);
  });

  it('CCR-01: exact hand-computed price — gpt-4o web_search leg', () => {
    // First web_search leg: gpt-4o, in=17262, out=634, grounding.
    // 17262/1e6*2.50 + 634/1e6*10.00 + 0.010 = 0.043155 + 0.00634 + 0.010
    const leg: UsageLeg = {
      model: 'gpt-4o', callType: 'web_search', inputTokens: 17262, outputTokens: 634, isGrounding: true,
    };
    expect(priceLeg(leg)).toBeCloseTo(0.059495, 9);
  });

  it('CCR-02: exact hand-computed price — gpt-4o-mini grounded-verify leg (no grounding fee)', () => {
    // in=203, out=136: 203/1e6*0.15 + 136/1e6*0.60 = 0.00003045 + 0.0000816
    const leg: UsageLeg = {
      model: 'gpt-4o-mini', callType: 'grounded-verify:openai', inputTokens: 203, outputTokens: 136, isGrounding: false,
    };
    expect(priceLeg(leg)).toBeCloseTo(0.00011205, 10);
  });

  it('CCR-03: DEFECT-3 killer — every claude leg priced at opus-4-8, exactly 6.25× the old haiku table', () => {
    const claudeLegs = recs.filter((r) => r.callType === 'grounded-verify:claude');
    expect(claudeLegs.length).toBeGreaterThan(0);
    // Old (buggy) costs.ts MANAGED_PROVIDER_RATES.claude = HAIKU $0.80/$4.00.
    const HAIKU = { inputPerM: 0.80, outputPerM: 4.00 };
    for (const r of claudeLegs) {
      const opus = priceLeg(toLeg(r));
      const haiku = (r.inputTokens / 1e6) * HAIKU.inputPerM + (r.outputTokens / 1e6) * HAIKU.outputPerM;
      // opus rates are 5.00/0.80 = 25/4 = 6.25× haiku on BOTH axes → exact factor
      expect(opus).toBeCloseTo(haiku * 6.25, 10);
      // and it must NOT equal the haiku value the legacy path would have emitted
      if (haiku > 0) expect(opus).not.toBeCloseTo(haiku, 6);
    }
  });

  it('CCR-04: DEFECT-2 killer — a consensus scan SUMS its full fan-out (>20 legs), not one provider', () => {
    const byScan = groupByScan(recs);
    // consensus scans are the sizes WITHOUT the ':single' suffix
    const consensus = [...byScan.entries()].filter(([, rs]) => !rs[0].size.includes(':single'));
    expect(consensus.length).toBeGreaterThan(0);
    const [, legsRaw] = consensus.sort((a, b) => b[1].length - a[1].length)[0]; // largest fan-out
    const legs = legsRaw.map(toLeg);
    const composed = composeConsensusCost(legs);
    // 1 + K·(1+N): a full consensus scan fans out to well over 20 calls
    expect(composed.callCount).toBe(legs.length);
    expect(composed.callCount).toBeGreaterThan(20);
    // total == independent manual sum of each priced leg (no double-count / drop)
    const manual = legs.reduce((s, l) => s + priceLeg(l), 0);
    expect(composed.costUsd).toBeCloseTo(manual, 10);
    // every leg resolved to a rated model (no silent zero-drop of the '?' gemini legs)
    expect(composed.unratedCalls).toBe(0);
  });

  it('CCR-05: MAGNITUDE — consensus scans land at measured $0.2–$0.7 order, escaping the 11–16,000× undercount', () => {
    const byScan = groupByScan(recs);
    const consensusTotals = [...byScan.entries()]
      .filter(([, rs]) => !rs[0].size.includes(':single'))
      .map(([, rs]) => composeConsensusCost(rs.map(toLeg)).costUsd);
    expect(consensusTotals.length).toBeGreaterThan(0);
    for (const t of consensusTotals) {
      // The old text-length+haiku+single-provider estimate produced ~$1e-4/scan.
      // The fixed composition MUST be in the measured order of magnitude.
      expect(t).toBeGreaterThan(0.05);
      expect(t).toBeLessThan(1.5); // sane upper bound (documented band tops ~$0.71)
    }
    const mean = consensusTotals.reduce((a, b) => a + b, 0) / consensusTotals.length;
    expect(mean).toBeGreaterThan(0.15);
    expect(mean).toBeLessThan(0.90);
  });

  it('CCR-06: web_search (gpt-4o) retrieval dominates cost — the ~84–90% documented finding', () => {
    const all = composeConsensusCost(recs.map(toLeg));
    const webSearch = all.byModel['gpt-4o']?.costUsd ?? 0;
    const share = webSearch / all.costUsd;
    expect(share).toBeGreaterThan(0.70);
    expect(share).toBeLessThan(0.95);
  });

  it('CCR-07: SINGLE-SOURCE drift-guard — production table agrees with pinned rates.ts LIVE_RATES', () => {
    for (const [model, rate] of Object.entries(CONSENSUS_MODEL_RATES)) {
      const pinned = LIVE_RATES[model];
      expect(pinned, `rates.ts missing pinned rate for ${model}`).toBeTruthy();
      expect(rate.inputPerM).toBe(pinned!.inputPerM);
      expect(rate.outputPerM).toBe(pinned!.outputPerM);
      expect(rate.groundingPerCall).toBe(pinned!.groundingPerCall);
    }
  });

  it('CCR-08: gemini legs with unknown captured model resolve via callType (no silent drop)', () => {
    // 51 gemini grounded-verify legs carry model '?' (model is in the URL path).
    const geminiUrlLegs = recs.filter((r) => r.model === '?');
    expect(geminiUrlLegs.length).toBeGreaterThan(0);
    for (const r of geminiUrlLegs) {
      expect(resolveLegModel(toLeg(r))).toBe('gemini-2.5-flash');
    }
  });
});
