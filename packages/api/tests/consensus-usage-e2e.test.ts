/**
 * consensus-usage-e2e.test.ts — BLG-005 phase-2 PROPAGATION gate.
 *
 * The load-bearing test the other suites route AROUND: it drives the REAL
 * scan() consensus pipeline (extraction → Promise.all(runSlot) → consensusVerify
 * → retriever + provider fan-out → recordUsage) inside a single captureUsage()
 * scope and asserts the legs actually propagate all the way back.
 *
 * WHY THIS MATTERS: every other BLG-005 test exercises a piece in isolation —
 * the composition on a static JSONL, the ALS sink with direct setTimeout, one
 * adapter method, or the routes with the mock provider (which records nothing →
 * the ESTIMATE fallback). None proves AsyncLocalStorage survives the engine's
 * Promise.all + consensusVerify fan-out. If it doesn't, production silently gets
 * legs=[] → falls back to the text-length estimate → the bug is UNFIXED while
 * every test is green. This test converts that unknown into an instrument.
 *
 * fetch is mocked (no network, no spend). Gemini is intentionally left out of
 * the voter set (no GEMINI_API_KEY) so every call is fetch-based and captured;
 * the GoogleGenAI SDK path is a separate, documented verification gap.
 *
 * Validates: BLG-CLX9-20260703-005 (real usage survives the real scan fan-out)
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { captureUsage } from '@nxtg/faultline/lib/usage-sink.js';
import { summarizeScanUsage, type UsageLeg } from '../src/store/consensus-cost.js';

const TEXT =
  'The Eiffel Tower was completed in 1889. Mount Everest is the highest mountain above sea level. ' +
  'Water boils at 100 degrees Celsius at sea level.';

// Route each provider URL to a realistic response CARRYING usage. recordUsage
// fires in each adapter's callAPI where it parses this — regardless of verdict.
function mockFetch(url: string) {
  if (url.includes('/responses')) {
    // OpenAI web_search retriever — the ~84–90% cost leg.
    return { ok: true, status: 200, json: async () => ({ output: [], usage: { input_tokens: 17262, output_tokens: 634 } }) };
  }
  if (url.includes('chat/completions')) {
    // OpenAI extraction + grounded verify. An array satisfies extractClaims;
    // verify still records usage (leg captured before content shape matters).
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: '[{"id":"1","text":"The Eiffel Tower was completed in 1889.","type":"fact","importance":3}]' } }],
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      }),
    };
  }
  if (url.includes('anthropic.com')) {
    return {
      ok: true, status: 200,
      json: async () => ({
        content: [{ type: 'text', text: '{"status":"supported","explanation":"ok"}' }],
        usage: { input_tokens: 300, output_tokens: 80 },
      }),
    };
  }
  return { ok: false, status: 404, json: async () => ({}) };
}

describe('consensus usage propagation (e2e through scan())', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) saved[k] = process.env[k];
    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
    delete process.env.GEMINI_API_KEY; // keep gemini out → all legs fetch-based
    vi.stubGlobal('fetch', vi.fn((input: unknown) => Promise.resolve(
      mockFetch(typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)) as unknown as Response,
    )));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('CUE-01: legs propagate through the real consensus fan-out (Promise.all + consensusVerify)', async () => {
    let legs: UsageLeg[] = [];
    await captureUsage(async () => {
      await scan(TEXT, 'openai', undefined, undefined, undefined, undefined, { consensus: true });
      // read inside the scope too later; captureUsage returns legs below
    }).then((r) => { legs = r.legs; });

    // The whole point: the fan-out's usage came back, NOT the empty set that
    // would silently trigger the estimate fallback.
    expect(legs.length).toBeGreaterThan(1);
    // web_search retriever leg survived the consensusVerify boundary
    expect(legs.some((l) => l.model === 'gpt-4o' && l.isGrounding)).toBe(true);
    // a claude opus voter leg survived
    expect(legs.some((l) => l.model === 'claude-opus-4-8')).toBe(true);
    // and the composed cost is the REAL magnitude, not the ~$1e-4 estimate
    expect(summarizeScanUsage(legs).costUsd).toBeGreaterThan(0.05);
  });

  it('CUE-02: single-provider (non-consensus) scan also propagates real usage', async () => {
    const { legs } = await captureUsage(() => scan(TEXT, 'openai'));
    expect(legs.length).toBeGreaterThan(0);
    expect(summarizeScanUsage(legs).costUsd).toBeGreaterThan(0);
    // no legs would mean the route falls back to the estimate — assert we didn't
    expect(legs.every((l) => l.provider === 'openai')).toBe(true);
  });
});
