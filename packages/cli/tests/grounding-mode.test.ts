// NEXUS: GoPMO 1.18.11.7.22 grounding provider
/**
 * The grounding mode in the engine (cli/grounding.ts, cli/verify-runner.ts).
 *
 * Real path: scan() → verify runner → Parallel retriever → geminiService,
 * with the Gemini SDK mocked at the module boundary and fetch stubbed for
 * Parallel. The mode is an argument: the engine never reads
 * FAULTLINE_GROUNDING; scanLocal (local runs) reads it from the user's env.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sdk = vi.hoisted(() => ({ configs: [] as Array<Record<string, any> | undefined>, prompts: [] as string[] }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { contents?: unknown; config?: Record<string, any> }) => {
        sdk.configs.push(params.config);
        const prompt = String(params.contents ?? '');
        sdk.prompts.push(prompt);
        if ((params.config?.tools ?? []).some((t: Record<string, unknown>) => 'googleSearch' in t)) {
          return {
            text: '{"status":"supported","explanation":"g"}', modelVersion: 'gemini-2.5-flash',
            candidates: [{ finishReason: 'STOP', groundingMetadata: { groundingChunks: [{ web: { title: 'G', uri: 'https://g.example/x' } }] } }],
          };
        }
        if (prompt.includes('Retrieved sources')) return { text: '{"status":"contradicted","explanation":"j"}', candidates: [{ finishReason: 'STOP' }] };
        return { text: JSON.stringify([{ id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 4 }]), candidates: [{ finishReason: 'STOP' }] };
      },
    };
  },
}));

import { scan } from '../cli/scan';
import { scanLocal } from '../cli/local-scan';
import { parseGroundingMode, groundingFromEnv } from '../cli/grounding';
import { resolveVerifier, resolveScanProviders, usesParallelGrounding, retrieveThenVerify, runVerification } from '../cli/verify-runner';
import { verifyClaimGrounded, groundedSourceLine } from '../services/geminiService';
import type { Claim } from '../types';
import type { LLMProvider, Retriever } from '../providers/base_provider';

const mockFetch = vi.fn();
const TEXT = 'The Eiffel Tower was completed in 1889.';
const CLAIM: Claim = { id: 'c1', text: TEXT, type: 'fact', importance: 4 };
const ENV = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'PARALLEL_API_KEY', 'FAULTLINE_GROUNDING', 'FAULTLINE_PARALLEL_MODE'];
let saved: Record<string, string | undefined>;

const parallelOk = () => new Response(JSON.stringify({
  search_id: 's', results: [{ url: 'https://p.example/eiffel', title: 'P', publish_date: '2021-03-04', excerpts: ['Completed 1889.'] }],
}), { status: 200 });

const googleSearchCalls = () => sdk.configs.filter((c) => (c?.tools ?? []).some((t: Record<string, unknown>) => 'googleSearch' in t)).length;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.GEMINI_API_KEY = 'g';
  process.env.PARALLEL_API_KEY = 'p';
  delete process.env.OPENAI_API_KEY;
  delete process.env.FAULTLINE_GROUNDING;
  delete process.env.FAULTLINE_PARALLEL_MODE;
  sdk.configs.length = 0;
  sdk.prompts.length = 0;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => parallelOk());
  vi.stubGlobal('fetch', mockFetch);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('the mode value', () => {
  it('is parallel only for that word; anything else is google', () => {
    expect(parseGroundingMode('parallel')).toBe('parallel');
    expect(parseGroundingMode(' PARALLEL ')).toBe('parallel');
    for (const v of [undefined, '', 'google', 'bing', 1, 'parallel-search']) expect(parseGroundingMode(v)).toBe('google');
    expect(groundingFromEnv({ FAULTLINE_GROUNDING: 'parallel' })).toBe('parallel');
    expect(groundingFromEnv({})).toBe('google');
  });
});

describe('which verify the mode changes', () => {
  it('only a non-consensus gemini verify gets the retrieve-then-judge rig', () => {
    expect(resolveVerifier('gemini', undefined, { grounding: 'parallel' }).groundedRig?.retriever.name).toBe('parallel-search');
    expect(resolveScanProviders('gemini', undefined, { grounding: 'parallel' }).verifier.groundedRig).toBeTruthy();
    expect(resolveVerifier('gemini', undefined, { grounding: 'google' }).groundedRig).toBeNull();
    expect(resolveVerifier('gemini').groundedRig).toBeNull();
    expect(resolveVerifier('mock', undefined, { grounding: 'parallel' }).groundedRig).toBeNull();
    expect(usesParallelGrounding('gemini', { consensus: true, consensusProviders: ['gemini'] }, { grounding: 'parallel' })).toBe(false);
    expect(usesParallelGrounding('gemini', undefined, { grounding: 'parallel' })).toBe(true);
    expect(usesParallelGrounding('openai', undefined, { grounding: 'parallel' })).toBe(false);
  });

  it('the engine does not read FAULTLINE_GROUNDING itself', () => {
    process.env.FAULTLINE_GROUNDING = 'parallel';
    expect(resolveVerifier('gemini').groundedRig).toBeNull();
  });

  it('a consensus scan in the parallel mode with no OpenAI key searches Parallel, never Gemini grounding', () => {
    const v = resolveVerifier('gemini', { consensus: true, consensusProviders: ['gemini'], verificationProvider: 'gemini' }, { grounding: 'parallel' });
    expect(v.consensusRig?.retriever.name).toBe('parallel-search');
    const g = resolveVerifier('gemini', { consensus: true, consensusProviders: ['gemini'], verificationProvider: 'gemini' });
    expect(g.consensusRig?.retriever.name).toBe('gemini-grounding');
  });
});

describe('scan() in the parallel mode', () => {
  it('makes zero googleSearch calls, one Parallel search, and binds Parallel provenance', async () => {
    const result = await scan(TEXT, 'gemini', undefined, undefined, undefined, undefined, undefined, { grounding: 'parallel' });
    const verdicts = Object.values(result.verifications);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts[0]).toMatchObject({
      status: 'contradicted',
      sources: [{ uri: 'https://p.example/eiffel', title: 'P', publishDate: '2021-03-04', excerpts: ['Completed 1889.'], snippet: 'Completed 1889.' }],
      provenance: { provider: 'gemini', model: 'gemini-2.5-flash', retriever: 'parallel-search', retrieverModel: 'parallel-search-advanced' },
    });
    expect(sdk.configs.length).toBeGreaterThan(0);
    expect(googleSearchCalls()).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sdk.prompts.some((p) => p.includes('Excerpt: Completed 1889.'))).toBe(true);
  });

  it('google (the default) is today\'s single grounded call, with no Parallel search', async () => {
    const result = await scan(TEXT, 'gemini');
    expect(Object.values(result.verifications).length).toBeGreaterThan(0);
    expect(Object.values(result.verifications)[0].provenance).toMatchObject({ retriever: 'gemini-grounding' });
    expect(googleSearchCalls()).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a Parallel failure is not checked: no judge call, no Google search', async () => {
    mockFetch.mockImplementation(async () => new Response('{}', { status: 500 }));
    const result = await scan(TEXT, 'gemini', undefined, undefined, undefined, undefined, undefined, { grounding: 'parallel' });
    const verdicts = Object.values(result.verifications);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts[0]).toMatchObject({ status: 'unverified', apiError: true, apiErrorReason: 'provider_error', sources: [] });
    expect(verdicts[0].provenance).toBeUndefined();
    expect(result.degraded).toBe(true);
    expect(googleSearchCalls()).toBe(0);
    expect(sdk.prompts.filter((p) => p.includes('Retrieved sources'))).toHaveLength(0);
  });
});

describe('scanLocal: the user\'s own env decides a local run', () => {
  it('unset: exactly scan() (Google grounding)', async () => {
    const result = await scanLocal(TEXT, 'gemini');
    expect(Object.keys(result.verifications).length).toBeGreaterThan(0);
    expect(googleSearchCalls()).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('FAULTLINE_GROUNDING=parallel in the user env: Parallel then Gemini, zero googleSearch calls', async () => {
    process.env.FAULTLINE_GROUNDING = 'parallel';
    const result = await scanLocal(TEXT, 'gemini');
    expect(Object.keys(result.verifications).length).toBeGreaterThan(0);
    expect(googleSearchCalls()).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('an explicit options.grounding wins over the env', async () => {
    process.env.FAULTLINE_GROUNDING = 'parallel';
    await scanLocal(TEXT, 'gemini', undefined, undefined, undefined, undefined, undefined, { grounding: 'google' });
    expect(googleSearchCalls()).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('retrieveThenVerify', () => {
  const judge = (impl: LLMProvider['verifyClaimGrounded']): LLMProvider => ({
    name: 'j', modelId: 'judge-1',
    extractClaims: async () => [], verifyClaim: async () => { throw new Error('verifyClaim must not be called'); },
    verifyClaimGrounded: impl, generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  });
  const retriever = (impl: Retriever['retrieve']): Retriever & { model: string } => ({ name: 'parallel-search', model: 'parallel-search-advanced', retrieve: impl });
  const SOURCES = [{ title: 't', uri: 'https://s.example/1', snippet: 'x' }];

  it('pins the verdict sources to the retrieved set and asks for excerpts in the prompt', async () => {
    const seen: unknown[] = [];
    const out = await retrieveThenVerify(CLAIM, judge(async (_c, s, o) => { seen.push(o); return { claimId: 'other', status: 'supported', explanation: 'e', sources: [{ title: 'forged', uri: 'https://forged.example' }] }; }), 'gemini', retriever(async () => SOURCES));
    expect(out.sources).toEqual(SOURCES);
    expect(out.claimId).toBe('c1');
    expect(seen).toEqual([{ withExcerpts: true, sourcesRule: true }]);
    expect(out.provenance).toMatchObject({ provider: 'gemini', model: 'judge-1', retriever: 'parallel-search', retrieverModel: 'parallel-search-advanced' });
  });

  it('a retriever that rejects with a plain error, or resolves nothing, is not checked', async () => {
    const thrown = await retrieveThenVerify(CLAIM, judge(async () => { throw new Error('unreachable'); }), 'gemini', retriever(async () => { throw new Error('429 Too Many Requests'); }));
    expect(thrown).toMatchObject({ status: 'unverified', apiError: true, apiErrorReason: 'rate_limited', sources: [] });
    const empty = await retrieveThenVerify(CLAIM, judge(async () => { throw new Error('unreachable'); }), 'gemini', retriever(async () => []));
    expect(empty).toMatchObject({ status: 'unverified', apiError: true, apiErrorReason: 'provider_error' });
  });

  it('a judge that throws, or reports its own failure, is not checked and carries no provenance', async () => {
    const thrown = await retrieveThenVerify(CLAIM, judge(async () => { throw new Error('503 Service Unavailable'); }), 'gemini', retriever(async () => SOURCES));
    expect(thrown).toMatchObject({ status: 'unverified', apiError: true, apiErrorReason: 'provider_unavailable' });
    const failed = await retrieveThenVerify(CLAIM, judge(async () => ({ claimId: 'c1', status: 'unverified', explanation: 'x', sources: SOURCES, apiError: true, apiErrorReason: 'output_truncated' })), 'gemini', retriever(async () => SOURCES));
    expect(failed).toMatchObject({ apiError: true, apiErrorReason: 'output_truncated' });
    expect(failed.provenance).toBeUndefined();
  });

  it('runs once per claim through runVerification: no retry of the search', async () => {
    let searches = 0;
    const v = { provider: judge(async () => ({ claimId: 'c1', status: 'supported', explanation: 'e', sources: [] })), providerName: 'gemini', consensusRig: null, groundedRig: { retriever: retriever(async () => { searches += 1; throw new Error('boom'); }) } };
    const run = await runVerification([CLAIM], v);
    expect(run.results.length).toBeGreaterThan(0);
    expect(run.results[0]).toMatchObject({ apiError: true });
    expect(searches).toBe(1);
  });
});

describe('the shared-source prompt', () => {
  it('lists excerpts only when asked, so the consensus prompt is unchanged', async () => {
    expect(groundedSourceLine({ title: 'T', uri: 'https://u', snippet: 'S' }, 0, false)).toBe('[1] T — https://u');
    expect(groundedSourceLine({ title: 'T', uri: 'https://u', snippet: 'S' }, 0, true)).toBe('[1] T — https://u\n    Excerpt: S');
    expect(groundedSourceLine({ title: 'T', uri: 'https://u' }, 1, true)).toBe('[2] T — https://u');
    await verifyClaimGrounded(CLAIM, [{ title: 'T', uri: 'https://u', snippet: 'SNIPPETTEXT' }], 'g');
    expect(sdk.prompts.at(-1)).not.toContain('SNIPPETTEXT');
    expect(sdk.configs.at(-1)?.tools).toBeUndefined();
    await verifyClaimGrounded(CLAIM, [{ title: 'T', uri: 'https://u', snippet: 'SNIPPETTEXT' }], 'g', { withExcerpts: true });
    expect(sdk.prompts.at(-1)).toContain('Excerpt: SNIPPETTEXT');
    expect(sdk.configs.at(-1)?.tools).toBeUndefined();
  });
});
