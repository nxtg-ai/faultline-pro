// Validates: N-234 (independent passage leg, GoPMO 1.18.11.3; emma-soul authorization al:e615798a8e8109c0)
/**
 * A second retriever's result pages are fetched and quoted into
 * independentEvidence, kept apart from the verdict's own sources, labelled with
 * that retriever, its model and the search time.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { attachIndependentEvidence } from '../evidence/independent.js';
import type { EvidenceFetch } from '../evidence/passage.js';
import { clearRobotsCache } from '../evidence/robots.js';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever.js';
import { GeminiGroundingRetriever } from '../providers/gemini_provider.js';
import type { RetrievalOutcome } from '../providers/base_provider.js';
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

/** A page fetch; robots.txt answers 404 (no rules) and is left out of `pages`. */
function pageFetch(fn: (url: string) => Response): EvidenceFetch {
  return vi.fn(async (url: string) => (url.endsWith('/robots.txt') ? new Response('', { status: 404 }) : fn(url))) as unknown as EvidenceFetch;
}
const pages = (f: EvidenceFetch): string[] =>
  (f as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).filter((u) => !u.endsWith('/robots.txt'));

beforeEach(() => clearRobotsCache());

/** A typed retriever: [] is a completed search that found nothing, a function throws. */
function retrieverOf(found: Array<Source & { snippet?: string }> | (() => never)) {
  const search = async (): Promise<Source[]> => (typeof found === 'function' ? found() : found);
  return {
    name: 'fixture-search',
    model: 'fixture-mini',
    retrieve: vi.fn(search),
    retrieveWithStatus: vi.fn(async (): Promise<RetrievalOutcome> => {
      const sources = await search();
      return sources.length > 0 ? { status: 'hits', sources } : { status: 'zero', sources: [] };
    }),
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
    const f = pageFetch((url) => (url.includes('kestrel') ? html(PAGE) : html('<p>Nothing relevant here.</p>')));
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
    expect(retriever.retrieveWithStatus).toHaveBeenCalledWith(CLAIM_TEXT);
  });

  it('fetches at most 3 result pages by default', async () => {
    const retriever = retrieverOf([1, 2, 3, 4, 5].map((n) => ({ title: `${n}`, uri: `https://p${n}.example/` })));
    const f = pageFetch(() => html(PAGE));
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever, fetch: f });
    expect(v.independentEvidence!.sources).toHaveLength(3);
    expect(pages(f)).toHaveLength(3);
  });

  it('a verdict whose check never ran pays for no search', async () => {
    const retriever = retrieverOf([{ title: 'x', uri: 'https://x.example/' }]);
    const errored = verdict({ apiError: true, status: 'unverified' });
    expect(await attachIndependentEvidence(errored, CLAIM_TEXT, { retriever, fetch: vi.fn() as never })).toBe(errored);
    expect(retriever.retrieveWithStatus).not.toHaveBeenCalled();
  });

  it('appliesTo false: the verdict is returned as given and no search is made', async () => {
    const retriever = retrieverOf([{ title: 'x', uri: 'https://x.example/' }]);
    const base = verdict();
    const v = await attachIndependentEvidence(base, CLAIM_TEXT, { retriever, fetch: vi.fn() as never, appliesTo: () => false });
    expect(v).toBe(base);
    expect(retriever.retrieveWithStatus).not.toHaveBeenCalled();
  });

  it('a retriever that throws or finds nothing yields an empty list, which says so', async () => {
    const throwing = retrieverOf(() => { throw new Error('down'); });
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever: throwing, fetch: vi.fn() as never });
    expect(v.independentEvidence!.sources).toEqual([]);
    expect(v.independentEvidence!.retriever).toBe('fixture-search');
  });

  it('a retriever that throws yields status provider_error with empty sources', async () => {
    const throwing = retrieverOf(() => { throw new Error('down'); });
    const f = vi.fn() as never;
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever: throwing, fetch: f });
    expect(v.independentEvidence).toBeDefined();
    expect(v.independentEvidence!.status).toBe('provider_error');
    expect(v.independentEvidence!.sources).toEqual([]);
    expect(JSON.stringify(v.independentEvidence)).not.toContain('down');
    expect(f).not.toHaveBeenCalled();
  });

  it('a retriever returning [] yields status zero', async () => {
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever: retrieverOf([]), fetch: vi.fn() as never });
    expect(v.independentEvidence).toBeDefined();
    expect(v.independentEvidence!.status).toBe('zero');
    expect(v.independentEvidence!.sources).toEqual([]);
    expect(v.independentEvidence!.detail).toBeUndefined();
  });

  it('a retriever returning sources yields status hits', async () => {
    const f = pageFetch(() => html(PAGE));
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever: retrieverOf([{ title: 'K', uri: 'https://k.example/' }]), fetch: f });
    expect(v.independentEvidence!.sources.length).toBeGreaterThan(0);
    expect(v.independentEvidence!.status).toBe('hits');
  });

  it('uses retrieveWithStatus when the retriever has it, and carries its status and detail', async () => {
    const retriever = {
      name: 'status-search',
      retrieve: vi.fn(async () => []),
      retrieveWithStatus: vi.fn(async () => ({ status: 'timeout' as const, sources: [], detail: 'deadline reached' })),
    };
    const f = vi.fn() as never;
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever, fetch: f });
    expect(v.independentEvidence).toBeDefined();
    expect(v.independentEvidence!.status).toBe('timeout');
    expect(v.independentEvidence!.detail).toBe('deadline reached');
    expect(v.independentEvidence!.sources).toEqual([]);
    expect(retriever.retrieve).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it('a retrieveWithStatus that throws is still provider_error', async () => {
    const retriever = { name: 'status-search', retrieve: vi.fn(async () => []), retrieveWithStatus: vi.fn(async () => { throw new Error('x'); }) };
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever, fetch: vi.fn() as never });
    expect(v.independentEvidence).toBeDefined();
    expect(v.independentEvidence!.status).toBe('provider_error');
  });

  it('the built-in Gemini grounding retriever with no key is provider_error, never zero', async () => {
    const f = vi.fn() as never;
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever: new GeminiGroundingRetriever(''), fetch: f });
    expect(v.independentEvidence).toBeDefined();
    expect(v.independentEvidence).toMatchObject({ retriever: 'gemini-grounding', status: 'provider_error', detail: 'missing api key', sources: [] });
    expect(f).not.toHaveBeenCalled();
  });

  it('a retriever without retrieveWithStatus is refused by the type, and read as provider_error at run time, never zero', async () => {
    const legacy = { name: 'legacy-search', retrieve: vi.fn(async () => [] as Source[]) };
    // @ts-expect-error independent evidence needs a retriever that reports how its search ended
    const v = await attachIndependentEvidence(verdict(), CLAIM_TEXT, { retriever: legacy, fetch: vi.fn() as never });
    expect(v.independentEvidence).toBeDefined();
    expect(v.independentEvidence!.status).toBe('provider_error');
    expect(v.independentEvidence!.detail).toBe('no retrieval status');
    expect(v.independentEvidence!.sources).toEqual([]);
    // [] from retrieve() cannot tell a failure from an empty search, so it is not asked.
    expect(legacy.retrieve).not.toHaveBeenCalled();
  });

  it('every built-in retriever reports a typed outcome', () => {
    expect(typeof new OpenAIWebSearchRetriever('k').retrieveWithStatus).toBe('function');
    expect(typeof new GeminiGroundingRetriever('k').retrieveWithStatus).toBe('function');
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
    const f = pageFetch(() => html(PAGE));
    const seen: VerificationResult[] = [];
    const r = await scan(CLAIM_TEXT, 'independent-fixture', undefined, undefined, undefined, (_c, v) => { seen.push(v); }, undefined, { independentEvidence: { retriever, fetch: f } });
    expect(seen[0].independentEvidence!.sources[0].evidence!.status).toBe('ok');
    expect(r.verifications.c1.independentEvidence!.retriever).toBe('fixture-search');
    const plain = await scan(CLAIM_TEXT, 'independent-fixture');
    expect(plain.verifications.c1.independentEvidence).toBeUndefined();
    expect(retriever.retrieveWithStatus).toHaveBeenCalledTimes(1);
  });
});
