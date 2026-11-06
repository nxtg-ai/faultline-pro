// NEXUS: N-237 citation claims, reference not found
/**
 * A citation claim (N-237) whose retrieved sources do not address the cited
 * work: the search found no record of it. For a claim that a work exists, that
 * is the finding, so the claim reads `unverified` with `referenceNotFound: true`
 * and REFERENCE_NOT_FOUND_EXPLANATION, and it counts toward the scan's risk.
 * A plain fact claim with the same judge reply stays not checkable.
 *
 * Real path for both grounding modes: scan() -> verify runner -> geminiService,
 * the Gemini SDK mocked at the module boundary and fetch stubbed for Parallel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  prompts: [] as string[],
  configs: [] as Array<Record<string, any> | undefined>,
  claims: [] as Array<{ id: string; text: string; type: string; importance: number }>,
  // Verify reply per claim text: the JSON the judge returns.
  replies: {} as Record<string, string>,
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { contents?: unknown; config?: Record<string, any> }) => {
        const prompt = String(params.contents ?? '');
        sdk.prompts.push(prompt);
        sdk.configs.push(params.config);
        const claim = sdk.claims.find((c) => prompt.includes(`Claim: "${c.text}"`));
        if (!claim) return { text: JSON.stringify(sdk.claims), candidates: [{ finishReason: 'STOP' }] };
        const text = sdk.replies[claim.text];
        if ((params.config?.tools ?? []).some((t: Record<string, unknown>) => 'googleSearch' in t)) {
          return {
            text, modelVersion: 'gemini-2.5-flash',
            candidates: [{
              finishReason: 'STOP',
              groundingMetadata: {
                groundingChunks: [{ web: { title: 'Unrelated', uri: 'https://g.example/other' } }],
                searchEntryPoint: { renderedContent: '<div>chip</div>' },
                webSearchQueries: ['q'],
              },
            }],
          };
        }
        return { text, candidates: [{ finishReason: 'STOP' }] };
      },
    };
  },
}));

import { scan } from '../cli/scan';
import { toClaimVerdict } from '../cli/verdict';
import {
  billingSummary, billableVerdictCount, isNotCheckable, abstainScanWithoutSource,
  NOT_CHECKABLE_EXPLANATION, REFERENCE_NOT_FOUND_EXPLANATION, referenceNotFoundVerdict,
} from '../lib/verdict-guard';
import type { VerificationResult } from '../types';
import type { GroundingMode } from '../cli/grounding';

const FAKE = 'The work "Sleep duration and overnight memory in adolescents" by Marchetti, L. (2018) exists as cited.';
const REAL = 'The work "Language models are few-shot learners" by Brown, T. (2020) exists as cited.';
const PLAIN = 'The Eiffel Tower was completed in 1889.';
const cite = (title: string, authors: string[], year: number) => ({ title, authors, year, raw: `${authors.join(', ')} (${year}). ${title}.` });
const CLAIMS = {
  fake: { id: 'r1', text: FAKE, type: 'fact', importance: 3, citation: cite('Sleep duration and overnight memory in adolescents', ['Marchetti, L.'], 2018) },
  real: { id: 'r2', text: REAL, type: 'fact', importance: 3, citation: cite('Language models are few-shot learners', ['Brown, T.'], 2020) },
  plain: { id: 'p1', text: PLAIN, type: 'fact', importance: 3 },
};
const reply = (status: string, addressed: boolean) => JSON.stringify({ status, explanation: 'judge words', sourcesAddressClaim: addressed });

const mockFetch = vi.fn();
const ENV = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'PARALLEL_API_KEY', 'FAULTLINE_GROUNDING', 'FAULTLINE_PARALLEL_MODE'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.GEMINI_API_KEY = 'g';
  process.env.PARALLEL_API_KEY = 'p';
  delete process.env.OPENAI_API_KEY;
  delete process.env.FAULTLINE_GROUNDING;
  delete process.env.FAULTLINE_PARALLEL_MODE;
  sdk.prompts.length = 0;
  sdk.configs.length = 0;
  sdk.claims = [];
  sdk.replies = {};
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({
    search_id: 's', results: [{ url: 'https://p.example/other', title: 'Unrelated', excerpts: ['About something else.'] }],
  }), { status: 200 }));
  vi.stubGlobal('fetch', mockFetch);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const runScan = (grounding: GroundingMode, text: string) =>
  scan(text, 'gemini', undefined, undefined, undefined, undefined, undefined, { grounding, doi: false } as never);

describe.each(['google', 'parallel'] as const)('the %s grounding mode', (grounding) => {
  const retriever = grounding === 'google' ? 'gemini-grounding' : 'parallel-search';

  it('a citation whose sources do not address the work reads reference not found and raises the risk', async () => {
    sdk.claims = [CLAIMS.fake as never, CLAIMS.plain as never];
    sdk.replies = { [FAKE]: reply('supported', false), [PLAIN]: reply('supported', true) };
    const result = await runScan(grounding, `${PLAIN}\n\nReferences\n1. ${CLAIMS.fake.citation.raw}`);
    const v = result.verifications.r1;
    expect(v).toBeDefined();
    expect(v).toMatchObject({ status: 'unverified', referenceNotFound: true, sources: [], explanation: REFERENCE_NOT_FOUND_EXPLANATION });
    expect('notCheckable' in v).toBe(false);
    expect('noSourceAbstain' in v).toBe(false);
    expect(v.apiError).toBeUndefined();
    expect(isNotCheckable(v)).toBe(false);
    expect(v.explanation).not.toContain('judge words');
    expect(v.searchEntryPoint).toBeUndefined();
    expect(v.provenance).toMatchObject({ provider: 'gemini', retriever });
    expect(result.verifications.p1.status).toBe('supported');
    // It counts: one unverified of two claims is at least high (calculateRisk).
    expect(result.overallRisk).toBe('high');
    // Never billed: not a definite verdict.
    expect(billableVerdictCount(result.verifications)).toBe(1);
    expect(billingSummary(result.verifications, ['r1', 'p1'])).toEqual({
      billedClaims: 1, unbilledClaims: 1, unbilled: [{ claimId: 'r1', reason: 'unverified' }],
    });
    // Not shown as "not checked": the guard and MCP surfaces see an unverified claim.
    expect(toClaimVerdict(FAKE, v)).toMatchObject({ verdict: 'UNSUPPORTED' });
    expect(toClaimVerdict(FAKE, v).unchecked_reason).toBeUndefined();
  });

  it('control: a plain fact claim with the same reply stays not checkable and adds no risk', async () => {
    sdk.claims = [CLAIMS.plain as never];
    sdk.replies = { [PLAIN]: reply('supported', false) };
    const result = await runScan(grounding, PLAIN);
    expect(result.verifications.p1).toMatchObject({ status: 'unverified', notCheckable: true, explanation: NOT_CHECKABLE_EXPLANATION });
    expect('referenceNotFound' in result.verifications.p1).toBe(false);
    expect(result.overallRisk).toBe('low');
  });

  it('a citation the sources do address keeps the judge verdict', async () => {
    sdk.claims = [CLAIMS.real as never];
    sdk.replies = { [REAL]: reply('supported', true) };
    const result = await runScan(grounding, `References\n1. ${CLAIMS.real.citation.raw}`);
    const v = result.verifications.r2;
    expect(v.status).toBe('supported');
    expect('referenceNotFound' in v).toBe(false);
    expect(v.sources.length).toBeGreaterThan(0);
  });
});

describe('referenceNotFoundVerdict', () => {
  it('survives the read-side guard unchanged (stored results read the same)', () => {
    const base: VerificationResult = { claimId: 'r1', status: 'unverified', explanation: NOT_CHECKABLE_EXPLANATION, sources: [], notCheckable: true };
    const v = referenceNotFoundVerdict(base);
    expect(v).toMatchObject({ status: 'unverified', referenceNotFound: true, explanation: REFERENCE_NOT_FOUND_EXPLANATION, sources: [] });
    expect('notCheckable' in v).toBe(false);
    const guarded = abstainScanWithoutSource({ verifications: { r1: v } } as never) as { verifications: Record<string, VerificationResult> };
    expect(guarded.verifications.r1).toEqual(v);
  });
});
