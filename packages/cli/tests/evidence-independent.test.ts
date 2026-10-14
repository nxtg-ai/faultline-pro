// Validates: N-234 (independent passage leg, GoPMO 1.18.11.3; emma-soul authorization al:e615798a8e8109c0)
/**
 * A second retriever's result pages are fetched and quoted into
 * independentEvidence, kept apart from the verdict's own sources, labelled with
 * that retriever, its model and the search time.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { attachIndependentEvidence } from '../evidence/independent.js';
import type { EvidenceFetch } from '../evidence/passage.js';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever.js';
import { scan } from '../cli/scan.js';
import { registerProvider } from '../providers/registry.js';
import type { Claim, Source, VerificationResult } from '../types.js';

const CLAIM_TEXT = 'The Eiffel Tower was completed in 1889.';
const PAGE = '<html><body><p>The Eiffel Tower was completed in March 1889 for the Exposition Universelle.</p></body></html>';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GROUNDED = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc';

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

function retrieverOf(found: Array<Source & { snippet?: string }> | (() => never)) {
  return {
    name: 'fixture-search',
    model: 'fixture-mini',
    retrieve: vi.fn(async () => (typeof found === 'function' ? found() : found)),
  };
}

const verdict = (over: Partial<VerificationResult> = {}): VerificationResult => ({
  claimId: 'c1', status: 'supported', explanation: 'ok',
  sources: [{ title: 'g', uri: GROUNDED, evidence: { status: 'not_fetched', reason: 'provider_terms', passage: null } }],
  ...over,
});

describe('attachIndependentEvidence', () => {
  it('quotes the second retriever\'s pages into its own labelled field and leaves the verdict\'s sources alone', async () => {
    const before = Date.now();
    const retriever = retrieverOf([
      { title: 'Kestrel', uri: 'https://kestrel.example/a', snippet: 'MODEL WORDS that are not evidence' },
      { title: 'Plain', uri: 'https://plain.example/b' },
    ]);
    const f = vi.fn(async (url: string) => (url.includes('kestrel') ? html(PAGE) : html('<p>Nothing relevant here.</p>'))) as unknown as EvidenceFetch;
    const base = verdict();
    const v = await attachIndependentEvidence(base, CLAIM_TEXT, { retriever, fetch: f });
    expect(v.sources).toEqual(base.sources);
    const ie = v.independentEvidence!;
    expect(ie.retriever).toBe('fixture-search');
    expect(ie.model).toBe('fixture-mini');
    expect(ie.retrievedAt).toMatch(ISO);
    expect(Date.parse(ie.retrievedAt)).toBeGreaterThanOrEqual(before);
    expect(ie.sources).toHaveLength(2);
    expect(ie.sources[0].evidence!.status).toBe('ok');
    expect(ie.sources[0].evidence!.passage).toBe('The Eiffel Tower was completed in March 1889 for the Exposition Universelle.');
    expect(ie.sources[1].evidence!.status).toBe('no_match');
    // The retriever's model-written snippet is never carried as evidence.
    expect(JSON.stringify(ie)).not.toContain('MODEL WORDS');
    expect(retriever.retrieve).toHaveBeenCalledWith(CLAIM_TEXT);
  });

  it('fetches at most 3 result pages by default', async () => {
    const retriever = retrieverOf([1, 2, 3, 4, 5].map((n) => ({ title: `${n}`, uri: `https://p${n}.example/` })));
    const f = vi.fn(async () => html(PAGE)) as unknown as EvidenceFetch;
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever, fetch: f });
    expect(v.independentEvidence!.sources).toHaveLength(3);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('a verdict whose check never ran pays for no search', async () => {
    const retriever = retrieverOf([{ title: 'x', uri: 'https://x.example/' }]);
    const errored = verdict({ apiError: true, status: 'unverified' });
    expect(await attachIndependentEvidence(errored, CLAIM_TEXT, { retriever, fetch: vi.fn() as never })).toBe(errored);
    expect(retriever.retrieve).not.toHaveBeenCalled();
  });

  it('appliesTo false: the verdict is returned as given and no search is made', async () => {
    const retriever = retrieverOf([{ title: 'x', uri: 'https://x.example/' }]);
    const base = verdict();
    const v = await attachIndependentEvidence(base, CLAIM_TEXT, { retriever, fetch: vi.fn() as never, appliesTo: () => false });
    expect(v).toBe(base);
    expect(retriever.retrieve).not.toHaveBeenCalled();
  });

  it('a retriever that throws or finds nothing yields an empty list, which says so', async () => {
    const throwing = retrieverOf(() => { throw new Error('down'); });
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever: throwing, fetch: vi.fn() as never });
    expect(v.independentEvidence!.sources).toEqual([]);
    expect(v.independentEvidence!.retriever).toBe('fixture-search');
  });

  it('a Google grounding Link returned by the second retriever is still never fetched', async () => {
    const retriever = retrieverOf([{ title: 'g', uri: GROUNDED }]);
    const f = vi.fn(async () => html(PAGE)) as unknown as EvidenceFetch;
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever, fetch: f });
    expect(v.independentEvidence!.sources[0].evidence).toEqual({ status: 'not_fetched', reason: 'provider_terms', passage: null });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('OpenAIWebSearchRetriever model', () => {
  it('takes the model from the constructor first', () => {
    expect(new OpenAIWebSearchRetriever('k', { model: 'gpt-4o-mini' }).model).toBe('gpt-4o-mini');
    expect(typeof new OpenAIWebSearchRetriever('k').model).toBe('string');
  });
});

describe('through scan()', () => {
  let savedKey: string | undefined;
  beforeAll(() => { savedKey = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'fixture-unused'; });
  afterAll(() => { if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey; });

  it('independentEvidence is on each reported verdict when asked for, and absent otherwise', async () => {
    registerProvider('independent-fixture', () => ({
      name: 'Independent fixture',
      modelId: 'fixture-v1',
      extractClaims: async (): Promise<Claim[]> => [{ id: 'c1', text: CLAIM_TEXT, type: 'fact', importance: 5 }],
      verifyClaim: async (c: Claim) => ({ claimId: c.id, status: 'supported', explanation: 'ok', sources: [] }),
      generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
    }) as never);
    const retriever = retrieverOf([{ title: 'Kestrel', uri: 'https://kestrel.example/a' }]);
    const f = vi.fn(async () => html(PAGE)) as unknown as EvidenceFetch;
    const seen: VerificationResult[] = [];
    const r = await scan(CLAIM_TEXT, 'independent-fixture', undefined, undefined, undefined, (_c, v) => { seen.push(v); }, undefined, { independentEvidence: { retriever, fetch: f } });
    expect(seen[0].independentEvidence!.sources[0].evidence!.status).toBe('ok');
    expect(r.verifications.c1.independentEvidence!.retriever).toBe('fixture-search');
    const plain = await scan(CLAIM_TEXT, 'independent-fixture');
    expect(plain.verifications.c1.independentEvidence).toBeUndefined();
    expect(retriever.retrieve).toHaveBeenCalledTimes(1);
  });
});
