/**
 * ParallelSearchRetriever with a mocked fetch: the v1 request it sends, how
 * results map to sources, and every failure class (each a RetrievalError with
 * its reason, so the claim reads as not checked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ParallelSearchRetriever, parseParallelResults, keywordQueries, searchObjective, parseParallelMode, parallelSearchModel,
  PARALLEL_SEARCH_URL, PARALLEL_SEARCH_CEILING,
} from '../providers/parallel_search_retriever';
import { HEALTHCARE_AUTHORITY_DOMAINS, parseSourcePolicy } from '../cli/source-policy';
import { SOURCE_POLICY_INVALID_EXPLANATION, SOURCE_POLICY_MISS_EXPLANATION } from '../providers/retrieval-error';
import { isRetrievalError, type RetrievalError } from '../providers/retrieval-error';
import { captureUsage } from '../lib/usage-sink';

const mockFetch = vi.fn();
const CLAIM = 'The Eiffel Tower was completed in 1889.';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Failure', headers: { 'content-type': 'application/json' } });
}

const RESULTS = {
  search_id: 'search_1',
  results: [
    { url: 'https://a.example/1', title: 'A', publish_date: '2024-05-01', excerpts: ['First excerpt.', 'Second excerpt.'] },
    { url: 'https://b.example/2', title: '', publish_date: null, excerpts: [] },
  ],
  usage: [{ name: 'sku_search', count: 1 }],
};

async function failure(p: Promise<unknown>): Promise<RetrievalError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).not.toBeNull();
  expect(isRetrievalError(err)).toBe(true);
  return err as RetrievalError;
}

let savedMode: string | undefined;
let savedPolicy: string | undefined;
beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  savedMode = process.env.FAULTLINE_PARALLEL_MODE;
  savedPolicy = process.env.FAULTLINE_SOURCE_POLICY;
  delete process.env.FAULTLINE_PARALLEL_MODE;
  delete process.env.FAULTLINE_SOURCE_POLICY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (savedMode === undefined) delete process.env.FAULTLINE_PARALLEL_MODE;
  else process.env.FAULTLINE_PARALLEL_MODE = savedMode;
  if (savedPolicy === undefined) delete process.env.FAULTLINE_SOURCE_POLICY;
  else process.env.FAULTLINE_SOURCE_POLICY = savedPolicy;
});

describe('the request', () => {
  it('POSTs the v1 body with objective, keyword queries, advanced mode and the ceiling, key in x-api-key', async () => {
    mockFetch.mockResolvedValueOnce(json(RESULTS));
    await new ParallelSearchRetriever('pk-1').retrieve(CLAIM);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PARALLEL_SEARCH_URL);
    expect(url).toBe('https://api.parallel.ai/v1/search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('pk-1');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      objective: expect.stringContaining(CLAIM),
      search_queries: ['Eiffel Tower completed 1889'],
      mode: 'advanced',
      max_chars_total: 12000,
      advanced_settings: { max_results: 8, excerpt_settings: { max_chars_per_result: 1500 } },
    });
    expect(body.objective).toMatch(/confirms it, and evidence that refutes/);
    // No policy: the serialized body is the historical one, byte for byte.
    const historical = JSON.stringify({
      objective: searchObjective(CLAIM),
      search_queries: ['Eiffel Tower completed 1889'],
      mode: 'advanced',
      max_chars_total: 12000,
      advanced_settings: { max_results: 8, excerpt_settings: { max_chars_per_result: 1500 } },
    });
    expect(String(init.body)).toBe(historical);
    expect(historical).not.toContain('source_policy');
    expect(historical).not.toContain('fetch_policy');
    expect(historical).not.toContain('include_domains');
  });

  it('ignores FAULTLINE_SOURCE_POLICY: the retriever sends a policy only when one is passed in', async () => {
    process.env.FAULTLINE_SOURCE_POLICY = 'healthcare-authority';
    mockFetch.mockResolvedValueOnce(json(RESULTS));
    await new ParallelSearchRetriever('k').retrieve(CLAIM);
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body));
    expect(body.advanced_settings).toEqual({ max_results: 8, excerpt_settings: { max_chars_per_result: 1500 } });
    expect(new ParallelSearchRetriever('k').sourcePolicy).toBeNull();
  });

  it('takes the mode from FAULTLINE_PARALLEL_MODE, an option over it, and an unknown value as advanced', async () => {
    process.env.FAULTLINE_PARALLEL_MODE = 'fast';
    expect(new ParallelSearchRetriever('k').mode).toBe('fast');
    expect(new ParallelSearchRetriever('k', { mode: 'turbo' }).model).toBe('parallel-search-turbo');
    process.env.FAULTLINE_PARALLEL_MODE = 'ultra';
    expect(new ParallelSearchRetriever('k').mode).toBe('advanced');
    expect(parseParallelMode(' BASIC ')).toBe('basic');
    expect(parseParallelMode(undefined)).toBe('advanced');
    expect(parallelSearchModel('advanced')).toBe('parallel-search-advanced');
  });

  it('builds at most two keyword queries of at most six content words', () => {
    expect(keywordQueries('The Eiffel Tower was completed in 1889.')).toEqual(['Eiffel Tower completed 1889']);
    const long = keywordQueries('Apple reported revenue of $94.9 billion for its fiscal fourth quarter of 2024, up six percent year over year.');
    expect(long.length).toBe(2);
    for (const q of long) expect(q.split(' ').length).toBeLessThanOrEqual(6);
    expect(long[0]).toBe('Apple reported revenue $94.9 billion fiscal');
    expect(keywordQueries('It is.')).toEqual(['It is']);
  });

  it('records one billed search on a 200, with the mode label, and nothing on a failure', async () => {
    mockFetch.mockResolvedValueOnce(json(RESULTS));
    const ok = await captureUsage(() => new ParallelSearchRetriever('k').retrieve(CLAIM));
    expect(ok.legs).toEqual([{ provider: 'parallel', model: 'parallel-search-advanced', callType: 'parallel-search', inputTokens: 0, outputTokens: 0, isGrounding: true }]);
    mockFetch.mockResolvedValueOnce(json({ error: 'x' }, 500));
    const failed = await captureUsage(() => new ParallelSearchRetriever('k').retrieve(CLAIM).catch(() => null));
    expect(failed.legs).toEqual([]);
  });
});

describe('results to sources', () => {
  it('keeps url, title, publish_date and excerpts; joins the excerpts as the snippet', async () => {
    mockFetch.mockResolvedValueOnce(json(RESULTS));
    const sources = await new ParallelSearchRetriever('k').retrieve(CLAIM);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toEqual([
      { title: 'A', uri: 'https://a.example/1', snippet: 'First excerpt. … Second excerpt.', excerpts: ['First excerpt.', 'Second excerpt.'], publishDate: '2024-05-01' },
      { title: 'https://b.example/2', uri: 'https://b.example/2' },
    ]);
  });

  it('drops a result with no http(s) url and a repeated url; caps results and snippet length', () => {
    const long = 'x'.repeat(5000);
    const many = Array.from({ length: 12 }, (_, i) => ({ url: `https://c.example/${i}`, title: `t${i}`, excerpts: [long] }));
    const sources = parseParallelResults({ results: [{ url: 'ftp://x/y', title: 'f' }, { title: 'no url' }, many[0], many[0], ...many.slice(1)] });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toHaveLength(PARALLEL_SEARCH_CEILING.maxResults);
    expect(new Set(sources.map((s) => s.uri)).size).toBe(sources.length);
    expect(sources.every((s) => s.uri.startsWith('https://'))).toBe(true);
    expect(sources[0].snippet!.length).toBe(PARALLEL_SEARCH_CEILING.maxCharsPerResult);
  });
});

describe('every failure is a classified RetrievalError, never a fallback', () => {
  it('no key: provider_error, and nothing is sent', async () => {
    const err = await failure(new ParallelSearchRetriever('').retrieve(CLAIM));
    expect(err.reason).toBe('provider_error');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [429, '{"error":"rate limit"}', 'rate_limited'],
    [402, '{"error":"payment required"}', 'provider_out_of_credits'],
    [503, '{"error":"busy"}', 'provider_unavailable'],
    [500, '{"error":"boom"}', 'provider_error'],
    [401, '{"error":"bad key"}', 'provider_error'],
    [422, '{"error":"unprocessable"}', 'provider_error'],
  ] as const)('HTTP %s: %s', async (status, body, reason) => {
    mockFetch.mockResolvedValueOnce(new Response(body, { status, statusText: 'Failure' }));
    const err = await failure(new ParallelSearchRetriever('k').retrieve(CLAIM));
    expect(err.reason).toBe(reason);
    // Customer-safe text only: the provider's body never reaches the explanation.
    expect(err.message).not.toContain('error');
  });

  it('timeout: the request is aborted at the deadline and reads timeout', async () => {
    mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const err = await failure(new ParallelSearchRetriever('k', { timeoutMs: 20 }).retrieve(CLAIM));
    expect(err.reason).toBe('timeout');
  });

  it('a network error reads provider_error', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await failure(new ParallelSearchRetriever('k').retrieve(CLAIM))).reason).toBe('provider_error');
  });

  it('empty results, no results field, or only unusable results: provider_error', async () => {
    for (const body of [{ search_id: 's', results: [] }, { search_id: 's' }, { results: [{ title: 'no url' }] }]) {
      mockFetch.mockResolvedValueOnce(json(body));
      expect((await failure(new ParallelSearchRetriever('k').retrieve(CLAIM))).reason).toBe('provider_error');
    }
  });

  it('an unreadable 200 body: provider_error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('<html>not json', { status: 200 }));
    expect((await failure(new ParallelSearchRetriever('k').retrieve(CLAIM))).reason).toBe('provider_error');
  });
});

// Validates: typed secondary retrieval status (the Parallel retriever reports how its search ended)
describe('retrieveWithStatus: how the search ended, never a throw', () => {
  it('hits: usable results come back as sources', async () => {
    mockFetch.mockResolvedValueOnce(json(RESULTS));
    const out = await new ParallelSearchRetriever('pk-1').retrieveWithStatus(CLAIM);
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.status).toBe('hits');
    expect(out.sources.map((s) => s.uri)).toEqual(['https://a.example/1', 'https://b.example/2']);
    expect(out.detail).toBeUndefined();
  });

  it('zero: a 200 with no result a reader can open, where retrieve() rejects', async () => {
    mockFetch.mockResolvedValueOnce(json({ search_id: 's', results: [] }));
    const r = new ParallelSearchRetriever('pk-1');
    expect(await r.retrieveWithStatus(CLAIM)).toEqual({ status: 'zero', sources: [] });
    mockFetch.mockResolvedValueOnce(json({ search_id: 's', results: [{ url: 'ftp://x', title: 'x', excerpts: [] }] }));
    expect(await r.retrieveWithStatus(CLAIM)).toEqual({ status: 'zero', sources: [] });
    mockFetch.mockResolvedValueOnce(json({ search_id: 's', results: [] }));
    expect((await failure(r.retrieve(CLAIM))).reason).toBe('provider_error');
  });

  it('provider_error: no key (no request), an HTTP error with only its code, a network error', async () => {
    expect(await new ParallelSearchRetriever('').retrieveWithStatus(CLAIM)).toEqual({ status: 'provider_error', sources: [], detail: 'missing api key' });
    expect(mockFetch).not.toHaveBeenCalled();
    mockFetch.mockResolvedValueOnce(new Response('SECRET upstream body', { status: 500, statusText: 'Server Error' }));
    const r = new ParallelSearchRetriever('pk-1');
    const out = await r.retrieveWithStatus(CLAIM);
    expect(out).toEqual({ status: 'provider_error', sources: [], detail: 'http 500' });
    expect(JSON.stringify(out)).not.toContain('SECRET');
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await r.retrieveWithStatus(CLAIM)).toEqual({ status: 'provider_error', sources: [], detail: 'network error' });
  });

  it('timeout: the call was stopped by its deadline', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('Parallel search timed out', 'TimeoutError'));
    const r = new ParallelSearchRetriever('pk-1');
    expect(await r.retrieveWithStatus(CLAIM)).toEqual({ status: 'timeout', sources: [], detail: 'deadline reached' });
    mockFetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    expect((await r.retrieveWithStatus(CLAIM)).status).toBe('timeout');
  });

  it('parse_error: a malformed result entry, even beside a valid one; retrieve() keeps main\'s rule', async () => {
    const r = new ParallelSearchRetriever('pk-1');
    for (const body of [{ results: [null] }, { results: [{ url: 42 }] }, { results: ['garbage'] }, { results: [RESULTS.results[0], null] }]) {
      mockFetch.mockResolvedValueOnce(json(body));
      expect(await r.retrieveWithStatus(CLAIM)).toEqual({ status: 'parse_error', sources: [], detail: 'unexpected shape' });
    }
    // retrieve() is unchanged: it keeps the valid entry and drops the malformed one.
    mockFetch.mockResolvedValueOnce(json({ results: [RESULTS.results[0], null] }));
    expect((await r.retrieve(CLAIM)).map((s) => s.uri)).toEqual(['https://a.example/1']);
  });

  it('parse_error: a 200 that is not JSON, or has no results list', async () => {
    mockFetch.mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    const r = new ParallelSearchRetriever('pk-1');
    expect(await r.retrieveWithStatus(CLAIM)).toEqual({ status: 'parse_error', sources: [], detail: 'bad json' });
    for (const body of [null, [], { search_id: 's' }, { results: 'bad' }]) {
      mockFetch.mockResolvedValueOnce(json(body));
      expect(await r.retrieveWithStatus(CLAIM)).toEqual({ status: 'parse_error', sources: [], detail: 'unexpected shape' });
    }
  });
});

describe('source policy', () => {
  const policy = parseSourcePolicy('healthcare-authority');
  const onList = {
    search_id: 's',
    results: [
      { url: 'https://www.cms.gov/medicare/fees', title: 'Fees', publish_date: '2024-06-01', excerpts: ['The fee schedule.'] },
      { url: 'https://www.nytimes.com/health', title: 'News', publish_date: '2024-06-01', excerpts: ['A report.'] },
      { url: 'https://pubmed.ncbi.nlm.nih.gov/1', title: 'PubMed', publish_date: '2024-06-01', excerpts: ['A trial.'] },
    ],
  };

  it('sends source_policy after the existing advanced_settings fields and drops pages outside the allowlist', async () => {
    expect(policy && !policy.invalid).toBe(true);
    mockFetch.mockResolvedValueOnce(json(onList));
    const retriever = new ParallelSearchRetriever('k', { sourcePolicy: policy });
    const sources = await retriever.retrieve(CLAIM);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sent = String(mockFetch.mock.calls[0][1].body);
    const plain = JSON.stringify(new ParallelSearchRetriever('k').requestBody(CLAIM));
    // source_policy is the last key of advanced_settings, so it sits before the two closing braces.
    expect(sent.startsWith(`${plain.slice(0, -2)},"source_policy":`)).toBe(true);
    expect(sent.endsWith('}}')).toBe(true);
    const body = JSON.parse(sent);
    expect(body.advanced_settings.source_policy).toEqual({ include_domains: [...HEALTHCARE_AUTHORITY_DOMAINS] });
    expect(body.advanced_settings.fetch_policy).toBeUndefined();
    expect(sources.map((s) => s.uri)).toEqual([
      'https://www.cms.gov/medicare/fees',
      'https://pubmed.ncbi.nlm.nih.gov/1',
    ]);
  });

  it('an allowlist miss is unverified at the retriever and does not search again', async () => {
    mockFetch.mockImplementation(async () => json({ search_id: 's', results: [{ url: 'https://news.example/a', title: 'N', excerpts: ['x'] }] }));
    const retriever = new ParallelSearchRetriever('k', { sourcePolicy: policy });
    const err = await failure(retriever.retrieve(CLAIM));
    expect(err.reason).toBe('provider_error');
    expect(err.message).toBe(SOURCE_POLICY_MISS_EXPLANATION);
    expect(err.message).not.toContain(CLAIM);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(mockFetch.mock.calls[0][1].body));
    expect(sent.advanced_settings.source_policy.include_domains).toEqual([...HEALTHCARE_AUTHORITY_DOMAINS]);
    expect(await retriever.retrieveWithStatus(CLAIM)).toEqual({ status: 'zero', sources: [] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const again = JSON.parse(String(mockFetch.mock.calls[1][1].body));
    expect(again.advanced_settings.source_policy.include_domains).toEqual([...HEALTHCARE_AUTHORITY_DOMAINS]);
  });

  it('an unusable policy searches nothing', async () => {
    const retriever = new ParallelSearchRetriever('k', { sourcePolicy: { includeDomains: [], excludeDomains: [], invalid: true } });
    const err = await failure(retriever.retrieve(CLAIM));
    expect(err.message).toBe(SOURCE_POLICY_INVALID_EXPLANATION);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await retriever.retrieveWithStatus(CLAIM)).toEqual({ status: 'provider_error', sources: [], detail: 'invalid source policy' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exclude and after_date are sent and applied, and an undated page does not pass an after-date', async () => {
    const custom = parseSourcePolicy({
      include_domains: ['cms.gov', 'fda.gov'],
      exclude_domains: ['cms.gov/archive'],
      after_date: '2024-01-01',
    });
    mockFetch.mockResolvedValueOnce(json({
      search_id: 's',
      results: [
        { url: 'https://www.cms.gov/medicare', title: 'Now', publish_date: '2024-01-01', excerpts: ['current'] },
        { url: 'https://www.cms.gov/archive/old', title: 'Old path', publish_date: '2024-06-01', excerpts: ['archived'] },
        { url: 'https://www.fda.gov/drugs', title: 'Old date', publish_date: '2023-12-31', excerpts: ['stale'] },
        { url: 'https://www.fda.gov/food', title: 'Undated', publish_date: null, excerpts: ['no date'] },
      ],
    }));
    const sources = await new ParallelSearchRetriever('k', { sourcePolicy: custom }).retrieve(CLAIM);
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body));
    expect(body.advanced_settings.source_policy).toEqual({
      include_domains: ['cms.gov', 'fda.gov'],
      exclude_domains: ['cms.gov/archive'],
      after_date: '2024-01-01',
    });
    expect(sources.map((s) => s.uri)).toEqual(['https://www.cms.gov/medicare']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('keywordQueries on hostile input (CodeQL: polynomial regex)', () => {
  it('trims a long run of punctuation in linear time and still yields a query', () => {
    const t0 = Date.now();
    const out = keywordQueries('#'.repeat(200_000) + 'Eiffel ' + ','.repeat(200_000) + ' Paris');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toContain('Eiffel');
    expect(out[0]).toContain('Paris');
  });
});

