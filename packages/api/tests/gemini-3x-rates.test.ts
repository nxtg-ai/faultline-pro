// Validates: GoPMO 1.18.11.7.127 (ruling Dx3 9ecdf6b8): the production judge can move to a Gemini
// 3.x model, so the spend ledger must price those calls at their own rates, and /health names the
// models the engine runs (the live probe reads it).
import { describe, it, expect } from 'vitest';
import { CONSENSUS_MODEL_RATES, summarizeScanUsage } from '../src/store/consensus-cost.js';
import { buildServer } from '../src/server.js';
import { GEMINI_MODEL, GEMINI_EXTRACTION_MODEL } from '@nxtg/faultline/services/geminiService.js';

describe('Gemini 3.x rates in the spend ledger', () => {
  it('has list-price rows for the three measured models', () => {
    expect(CONSENSUS_MODEL_RATES['gemini-3.5-flash-lite']).toMatchObject({ inputPerM: 0.30, outputPerM: 2.50 });
    expect(CONSENSUS_MODEL_RATES['gemini-3.8-flash']).toMatchObject({ inputPerM: 0.75, outputPerM: 3.75 });
    expect(CONSENSUS_MODEL_RATES['gemini-3.1-pro-preview']).toMatchObject({ inputPerM: 2.00, outputPerM: 12.00 });
  });

  it('prices a pro-preview judge leg at its own rate, not the 2.5-flash fallback', () => {
    const legs = [
      { model: 'gemini-3.5-flash-lite', callType: 'extraction', provider: 'gemini', inputTokens: 1_000, outputTokens: 2_000, isGrounding: false },
      { model: 'gemini-3.1-pro-preview', callType: 'grounded-verify:gemini', provider: 'gemini', inputTokens: 3_000, outputTokens: 500, isGrounding: false },
    ];
    const usage = summarizeScanUsage(legs);
    expect(usage.unratedCalls).toBe(0);
    // lite: 1000 x 0.30 + 2000 x 2.50 = 5,300 per million; pro: 3000 x 2 + 500 x 12 = 12,000 per million.
    expect(usage.costUsd).toBeCloseTo((5_300 + 12_000) / 1_000_000, 10);
  });
});

describe('Gemini 3 Google Search grounding is priced per query', () => {
  const grounded = (searchQueries?: number) => ({
    model: 'gemini-3.1-pro-preview', callType: 'grounded-verify:gemini', provider: 'gemini',
    inputTokens: 0, outputTokens: 0, isGrounding: true, ...(searchQueries === undefined ? {} : { searchQueries }),
  });

  it('three queries cost three times 0.014 USD', () => {
    expect(summarizeScanUsage([grounded(3)]).costUsd).toBeCloseTo(0.042, 10);
  });

  it('an unreported or zero query count is charged one query, never zero', () => {
    expect(summarizeScanUsage([grounded()]).costUsd).toBeCloseTo(0.014, 10);
    expect(summarizeScanUsage([grounded(0)]).costUsd).toBeCloseTo(0.014, 10);
  });

  it('2.5-flash keeps its per-prompt rate, whatever the query count', () => {
    const leg = { ...grounded(4), model: 'gemini-2.5-flash' };
    expect(summarizeScanUsage([leg]).costUsd).toBeCloseTo(0.035, 10);
  });

  it('a Parallel search leg is unchanged', () => {
    const leg = { model: 'parallel-search-advanced', callType: 'parallel-search', provider: 'parallel', inputTokens: 0, outputTokens: 0, isGrounding: true };
    expect(summarizeScanUsage([leg]).costUsd).toBeCloseTo(0.005, 10);
  });
});

describe('/health names the Gemini models', () => {
  it('reports the judge and the extraction model this process runs', async () => {
    const server = buildServer();
    await server.ready();
    try {
      const body = (await server.inject({ method: 'GET', url: '/health' })).json();
      expect(body.models).toEqual({ judge: GEMINI_MODEL, extraction: GEMINI_EXTRACTION_MODEL });
      expect(typeof body.models.judge).toBe('string');
      expect(body.models.judge.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
