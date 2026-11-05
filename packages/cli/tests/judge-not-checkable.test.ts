// NEXUS: GoPMO 1.18.11.7.19 judge-side not checkable
/**
 * A claim the retrieved sources do not address is not checkable, on the judge
 * side (GoPMO 1.18.11.7.19). The judge's reply carries `sourcesAddressClaim`;
 * `false` makes the claim `unverified` with `notCheckable: true`, no sources and
 * a fixed explanation, whatever status it gave. It adds no risk, is never
 * billed, and reads UNCHECKED / not_verifiable on the guard and MCP surfaces.
 * A claim the sources do address keeps today's behaviour exactly.
 *
 * Real path for both grounding modes: scan() → verify runner → geminiService,
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
import { verifyClaimGrounded } from '../services/geminiService';
import { retrieveThenVerify } from '../cli/verify-runner';
import { toClaimVerdict, isProviderUnchecked } from '../cli/verdict';
import { evaluateGuard } from '../cli/guard';
import { calculateRisk } from '../lib/overall-risk';
import { extractFailedClaims } from '../analysis/critique';
import { analyzeWeakestLinks } from '../analysis/weakest-link';
import {
  abstainWithoutSource, abstainScanWithoutSource, billingSummary, billableVerdictCount, isBillableVerdict,
  isNotCheckable, notCheckableVerdict, NOT_CHECKABLE_EXPLANATION, NO_SOURCE_EXPLANATION,
} from '../lib/verdict-guard';
import { readVerdictReply, SOURCES_ADDRESS_RULE } from '../providers/verdict-reply';
import type { Claim, VerificationResult } from '../types';
import type { LLMProvider, Retriever } from '../providers/base_provider';
import type { GroundingMode } from '../cli/grounding';

const DOC = 'This report covers three models.';
const WORLD = 'The Eiffel Tower was completed in 1889.';
const WRONG = 'The Eiffel Tower was completed in 1925.';
const CLAIMS = [
  { id: 'd1', text: DOC, type: 'fact', importance: 3 },
  { id: 'w1', text: WORLD, type: 'fact', importance: 3 },
  { id: 'w2', text: WRONG, type: 'fact', importance: 3 },
];
const reply = (status: string, addressed?: unknown) => JSON.stringify({
  status, explanation: 'judge words',
  ...(addressed === undefined ? {} : { sourcesAddressClaim: addressed }),
});

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
  sdk.claims = CLAIMS.map((c) => ({ ...c }));
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

const runScan = (grounding: GroundingMode, text = `${DOC} ${WORLD} ${WRONG}`) =>
  scan(text, 'gemini', undefined, undefined, undefined, undefined, undefined, { grounding });

/** The verify prompts the scan sent (not the extraction prompt). */
const verifyPrompts = () => sdk.prompts.filter((p) => p.includes('Claim: "'));

describe.each(['google', 'parallel'] as const)('the %s grounding mode', (grounding) => {
  const retriever = grounding === 'google' ? 'gemini-grounding' : 'parallel-search';

  it('a document-scope claim with unrelated sources ends not checkable, with zero added risk and not billed', async () => {
    sdk.claims = [CLAIMS[0], CLAIMS[1]];
    sdk.replies = { [DOC]: reply('contradicted', false), [WORLD]: reply('supported', true) };
    const result = await runScan(grounding, `${DOC} ${WORLD}`);
    const doc = result.verifications.d1;
    expect(doc).toMatchObject({ status: 'unverified', notCheckable: true, sources: [], explanation: NOT_CHECKABLE_EXPLANATION });
    expect(doc.apiError).toBeUndefined();
    expect('noSourceAbstain' in doc).toBe(false);
    // The judge's own words and Google's grounded fields do not ride on a result Faultline rewrote.
    expect(doc.explanation).not.toContain('judge words');
    expect(doc.searchEntryPoint).toBeUndefined();
    expect(doc.webSearchQueries).toBeUndefined();
    // Checked, so provenance stays.
    expect(doc.provenance).toMatchObject({ provider: 'gemini', retriever });
    expect(result.verifications.w1.status).toBe('supported');
    // Zero added risk: the band is the one supported claim's band.
    expect(result.overallRisk).toBe('low');
    expect(calculateRisk({ w1: result.verifications.w1 })).toBe('low');
    expect(result.degraded).not.toBe(true);
    // Billing: only the supported claim; the other is unbilled as not_checkable.
    expect(billableVerdictCount(result.verifications)).toBe(1);
    expect(billingSummary(result.verifications, ['d1', 'w1'])).toEqual({
      billedClaims: 1, unbilledClaims: 1, unbilled: [{ claimId: 'd1', reason: 'not_checkable' }],
    });
    // Shown as not checked, not as a failure.
    expect(toClaimVerdict(DOC, doc)).toMatchObject({ verdict: 'UNCHECKED', unchecked_reason: 'not_verifiable', evidence_urls: [] });
    const gate = evaluateGuard(result, 'unsupported');
    expect(gate.exitCode).toBe(0);
    expect(gate.degraded).toBe(false);
    expect(gate.tripped).toEqual([]);
  });

  it('control: the same claim without the key is contradicted and raises the risk, as today', async () => {
    sdk.claims = [CLAIMS[0], CLAIMS[1]];
    sdk.replies = { [DOC]: reply('contradicted'), [WORLD]: reply('supported', true) };
    const result = await runScan(grounding, `${DOC} ${WORLD}`);
    expect(result.verifications.d1.status).toBe('contradicted');
    expect('notCheckable' in result.verifications.d1).toBe(false);
    expect(result.overallRisk).toBe('high');
  });

  it('a world claim whose sources contradict it stays contradicted', async () => {
    sdk.claims = [CLAIMS[2]];
    sdk.replies = { [WRONG]: reply('contradicted', true) };
    const result = await runScan(grounding, WRONG);
    const v = result.verifications.w2;
    expect(v.status).toBe('contradicted');
    expect('notCheckable' in v).toBe(false);
    expect(v.sources.length).toBeGreaterThan(0);
    expect(result.overallRisk).toBe('high');
    expect(isBillableVerdict(v)).toBe(true);
    expect(toClaimVerdict(WRONG, v).verdict).toBe('REFUTED');
  });

  it('a world claim with sources that do not address it becomes not checkable (intended)', async () => {
    sdk.claims = [CLAIMS[1]];
    sdk.replies = { [WORLD]: reply('supported', false) };
    const result = await runScan(grounding, WORLD);
    expect(result.verifications.w1).toMatchObject({ status: 'unverified', notCheckable: true, sources: [] });
    expect(billableVerdictCount(result.verifications)).toBe(0);
  });

  it('a reply without the key, or with a non-boolean value, keeps the status as given', async () => {
    for (const addressed of [undefined, 'false', 0, null]) {
      sdk.claims = [CLAIMS[2]];
      sdk.replies = { [WRONG]: reply('contradicted', addressed) };
      const result = await runScan(grounding, WRONG);
      expect(result.verifications.w2.status).toBe('contradicted');
      expect('notCheckable' in result.verifications.w2).toBe(false);
    }
  });

  it('the verify prompt carries the sources rule once, the same text in both modes', async () => {
    sdk.claims = [CLAIMS[1]];
    sdk.replies = { [WORLD]: reply('supported', true) };
    await runScan(grounding, WORLD);
    const prompts = verifyPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].split(SOURCES_ADDRESS_RULE)).toHaveLength(2);
    expect(prompts[0]).toContain('"sourcesAddressClaim": true | false');
  });
});

describe('outside the two grounding modes', () => {
  it('the consensus prompt (verifyClaimGrounded without sourcesRule) is unchanged and ignores the key', async () => {
    sdk.claims = [CLAIMS[0]];
    sdk.replies = { [DOC]: reply('contradicted', false) };
    const out = await verifyClaimGrounded(CLAIMS[0] as Claim, [{ title: 'T', uri: 'https://u.example' }], 'g');
    expect(sdk.prompts.at(-1)).not.toContain(SOURCES_ADDRESS_RULE);
    expect(sdk.prompts.at(-1)).not.toContain('sourcesAddressClaim');
    expect(out.status).toBe('contradicted');
    expect('notCheckable' in out).toBe(false);
  });

  it('retrieveThenVerify asks for the rule and keeps no retrieved source on a not-checkable claim', async () => {
    const seen: unknown[] = [];
    const judge: LLMProvider = {
      name: 'j', modelId: 'judge-1',
      extractClaims: async () => [], verifyClaim: async () => { throw new Error('unused'); },
      verifyClaimGrounded: async (c, s, o) => { seen.push(o); return notCheckableVerdict({ claimId: c.id, status: 'contradicted', explanation: 'x', sources: s }); },
      generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
    };
    const r: Retriever = { name: 'parallel-search', retrieve: async () => [{ title: 't', uri: 'https://s.example/1' }] };
    const out = await retrieveThenVerify(CLAIMS[0] as Claim, judge, 'gemini', r);
    expect(seen).toEqual([{ withExcerpts: true, sourcesRule: true }]);
    expect(out).toMatchObject({ status: 'unverified', notCheckable: true, sources: [], provenance: { retriever: 'parallel-search' } });
  });
});

describe('the reply parser', () => {
  it('reads sourcesAddressClaim only as a JSON boolean', () => {
    expect(readVerdictReply(reply('supported', false))).toEqual({ status: 'supported', explanation: 'judge words', sourcesAddressClaim: false });
    expect(readVerdictReply(reply('supported', true))?.sourcesAddressClaim).toBe(true);
    for (const v of [undefined, 'false', 0, null, {}]) {
      expect('sourcesAddressClaim' in (readVerdictReply(reply('supported', v)) ?? {})).toBe(false);
    }
    // The key never makes an unreadable reply readable.
    expect(readVerdictReply('{"sourcesAddressClaim":false}')).toBeNull();
  });
});

const base = (over: Partial<VerificationResult> = {}): VerificationResult => ({
  claimId: 'c', status: 'contradicted', explanation: 'e', sources: [{ title: 's', uri: 'https://s.example' }], ...over,
});

describe('the not-checkable rule in verdict-guard', () => {
  it('rewrites any status, drops sources, noSourceAbstain and grounded fields, keeps provenance', () => {
    const provenance = { provider: 'gemini', model: 'm', verifiedAt: 't', retriever: 'gemini-grounding' };
    for (const status of ['supported', 'contradicted', 'mixed', 'unverified'] as const) {
      const input = { ...base({ status, notCheckable: true, noSourceAbstain: true, provenance, webSearchQueries: ['q'], searchEntryPoint: { renderedContent: 'x' } }) };
      const out = abstainWithoutSource(input);
      expect(out).toEqual({ claimId: 'c', status: 'unverified', explanation: NOT_CHECKABLE_EXPLANATION, sources: [], notCheckable: true, provenance });
      // Idempotent: a settled result comes back as the same object.
      expect(abstainWithoutSource(out)).toBe(out);
      expect(notCheckableVerdict(out)).toBe(out);
    }
  });

  it('an API error is never not checkable, and stays an API error', () => {
    const err = base({ status: 'unverified', apiError: true, apiErrorReason: 'provider_error', notCheckable: true, sources: [] });
    expect(isNotCheckable(err)).toBe(false);
    expect(abstainWithoutSource(err)).toBe(err);
    expect(billingSummary({ c: err }).unbilled).toEqual([{ claimId: 'c', reason: 'provider_error' }]);
  });

  it('without the flag the abstain rule is unchanged', () => {
    const ok = base();
    expect(abstainWithoutSource(ok)).toBe(ok);
    const noSource = abstainWithoutSource(base({ sources: [] }));
    expect(noSource).toMatchObject({ status: 'unverified', noSourceAbstain: true, explanation: NO_SOURCE_EXPLANATION });
    expect('notCheckable' in noSource).toBe(false);
    expect(billingSummary({ c: noSource }).unbilled).toEqual([{ claimId: 'c', reason: 'no_source' }]);
  });

  it('a stored result carrying the flag is guarded on read', () => {
    const stored = { verifications: { c: base({ notCheckable: true }) } };
    const read = abstainScanWithoutSource(stored);
    expect(read.verifications.c).toMatchObject({ status: 'unverified', notCheckable: true, sources: [] });
    expect(stored.verifications.c.status).toBe('contradicted');
  });
});

describe('what a not-checkable claim does downstream', () => {
  const nc = notCheckableVerdict(base());

  it('adds no risk: left out of every count, the total included', () => {
    expect(calculateRisk({ a: nc })).toBe('low');
    expect(calculateRisk({ a: nc, b: base({ status: 'supported' }) })).toBe('low');
    // Two not-checkable beside one unverified: the unverified half-share rule sees one of one.
    expect(calculateRisk({ a: nc, b: { ...nc, claimId: 'b' }, c: base({ status: 'unverified', sources: [] }) })).toBe('high');
    // A no-source abstain still raises the band, as before.
    expect(calculateRisk({ a: base({ status: 'unverified', sources: [], noSourceAbstain: true }), b: base({ status: 'supported' }), c: base({ status: 'supported' }) })).toBe('medium');
    // An API error with the flag counts as unverified, as before.
    expect(calculateRisk({ a: { ...nc, apiError: true }, b: base({ status: 'supported' }), c: base({ status: 'supported' }) })).toBe('medium');
  });

  it('maps to UNCHECKED / not_verifiable, which is not a provider failure', () => {
    const entry = toClaimVerdict(DOC, nc);
    expect(entry.verdict).toBe('UNCHECKED');
    expect(entry.unchecked_reason).toBe('not_verifiable');
    expect(isProviderUnchecked(entry.unchecked_reason)).toBe(false);
    // A plain unverified is still UNSUPPORTED.
    expect(toClaimVerdict(DOC, base({ status: 'unverified', sources: [] })).verdict).toBe('UNSUPPORTED');
  });

  it('is not a failed claim for the critique, and not the weakest link', () => {
    const claims: Claim[] = [
      { id: 'a', text: DOC, type: 'fact', importance: 5 },
      { id: 'b', text: WORLD, type: 'fact', importance: 3 },
    ];
    const verifications = { a: { ...nc, claimId: 'a' }, b: base({ claimId: 'b', status: 'supported' }) };
    expect(extractFailedClaims(claims, verifications)).toEqual([]);
    expect(extractFailedClaims(claims, { ...verifications, a: base({ claimId: 'a', status: 'unverified', sources: [] }) }).map((c) => c.id)).toEqual(['a']);
    const report = {
      generatedAt: 't', overallRiskLevel: 'low',
      euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 0, totalClaims: 0, highestTier: 'minimal' },
      claimMappings: [], triggeredArticles: [], mitigations: [], confidenceDistribution: { high: 0, medium: 0, low: 0 },
    } as never;
    const links = analyzeWeakestLinks(claims, verifications, report);
    expect(links.rankedClaims.map((c) => c.claimId)).toEqual(['b']);
  });
});
