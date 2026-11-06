/**
 * Direct DOI check for citation claims (evidence/doi.ts).
 *
 * Every test drives checkCitationDoi through an injected fetch: no network.
 * The replies mirror what doi.org and api.crossref.org answered on 2026-11-05:
 * a known DOI gives 200 + `responseCode: 1`; an unknown one gives HTTP 404 +
 * `responseCode: 100`; Crossref answers a DOI it does not hold with 404 text.
 *
 * Validates: N-237 (citation claims, direct DOI check)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  checkCitationDoi, titleSimilarity, doiHandleUrl, crossrefWorkUrl, DOI_RETRIEVER, DOI_USER_AGENT,
  resolveDoiCheck, setDefaultDoiCheck, resetDefaultDoiCheck, type DoiCheckOptions,
} from '../evidence/doi.js';
import { normalizeDoi } from '../lib/citation.js';
import { isBillableVerdict, abstainWithoutSource } from '../lib/verdict-guard.js';
import type { Claim } from '../types.js';

const REAL_DOI = '10.1038/nature14539';
const FAKE_DOI = '10.4471/jca.2021.0388';
const REAL_TITLE = 'Deep learning';

interface Call { url: string; init: RequestInit }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch answering by URL; records every request. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>): { opts: DoiCheckOptions; calls: Call[] } {
  const calls: Call[] = [];
  const opts: DoiCheckOptions = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const route = routes[url];
      if (!route) throw new Error(`unexpected request ${url}`);
      return route();
    },
  };
  return { opts, calls };
}

const handleFound = (doi: string) => () => json(200, { responseCode: 1, handle: doi, values: [] });
const handleMissing = (doi: string) => () => json(404, { responseCode: 100, handle: doi });
const crossrefWork = (title: string[], subtitle: string[] = []) => () =>
  json(200, { status: 'ok', 'message-type': 'work', message: { DOI: REAL_DOI, title, subtitle } });
const crossrefMissing = () => new Response('Resource not found.', { status: 404, headers: { 'content-type': 'text/plain' } });

function citationClaim(citation: Claim['citation'], id = 'c1'): Claim {
  return { id, text: 'The work exists as cited.', type: 'fact', importance: 3, citation };
}

const realCitation = { title: REAL_TITLE, authors: 'LeCun, Y., Bengio, Y. & Hinton, G.', year: '2015', venue: 'Nature', doi: REAL_DOI };

describe('normalizeDoi', () => {
  it.each([
    ['10.1038/nature14539', REAL_DOI],
    ['https://doi.org/10.1038/nature14539', REAL_DOI],
    ['http://dx.doi.org/10.1038/nature14539', REAL_DOI],
    ['doi.org/10.1038/nature14539', REAL_DOI],
    ['doi:10.1038/nature14539', REAL_DOI],
    ['DOI: 10.1038/nature14539', REAL_DOI],
    ['  10.1038/NATURE14539  ', REAL_DOI],
    ['10.1038/nature14539.', REAL_DOI],
    ['10.1038/nature14539,', REAL_DOI],
    ['10.1038/nature14539);', REAL_DOI],
    ['https://doi.org/10.1002/%28SICI%291097-4636', '10.1002/(sici)1097-4636'],
    ['10.1016/0002-9149(83)90321-6', '10.1016/0002-9149(83)90321-6'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeDoi(raw)).toBe(expected);
  });

  it.each([
    ['not a doi'], [''], ['11.1038/nature14539'], ['10.12/short-registrant'],
    ['10.1038/has space'], ['10.1038/x?query=1'], ['10.1038/x#frag'], ['10.1038/'],
  ])('rejects %j', (raw) => {
    expect(normalizeDoi(raw)).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(normalizeDoi(42)).toBeNull();
    expect(normalizeDoi(undefined)).toBeNull();
  });
});

describe('titleSimilarity', () => {
  it('scores case, punctuation and markup differences as identical', () => {
    expect(titleSimilarity('Deep learning', 'Deep Learning.')).toBe(1);
    expect(titleSimilarity('In vitro assays', '<i>In vitro</i> assays')).toBe(1);
    expect(titleSimilarity('Café culture', 'Cafe culture')).toBe(1);
  });

  it('scores a cited title missing its subtitle as a match when it has 3+ words', () => {
    expect(titleSimilarity('Attention is all you need', 'Attention is all you need: a retrospective')).toBe(1);
  });

  it('scores unrelated titles low', () => {
    expect(titleSimilarity('Deep learning', 'Protein structure prediction with transformers')).toBe(0);
  });
});

describe('checkCitationDoi', () => {
  it('found + title match: supported, billable, sourced from doi.org and Crossref', async () => {
    const { opts, calls } = fakeFetch({
      [doiHandleUrl(REAL_DOI)]: handleFound(REAL_DOI),
      [crossrefWorkUrl(REAL_DOI)]: crossrefWork(['Deep learning']),
    });
    const result = await checkCitationDoi(citationClaim(realCitation), opts);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('supported');
    expect(result!.claimId).toBe('c1');
    expect(result!.sources.map((s) => s.uri)).toEqual([`https://doi.org/${REAL_DOI}`, crossrefWorkUrl(REAL_DOI)]);
    expect(result!.provenance?.retriever).toBe(DOI_RETRIEVER);
    expect(isBillableVerdict(result)).toBe(true);
    // The no-source guard keeps both sources: they are openable https links.
    expect(abstainWithoutSource(result!)).toBe(result);
    expect(calls).toHaveLength(2);
  });

  it('found + title match via the Crossref subtitle', async () => {
    const { opts } = fakeFetch({
      [doiHandleUrl(REAL_DOI)]: handleFound(REAL_DOI),
      [crossrefWorkUrl(REAL_DOI)]: crossrefWork(['Deep learning'], ['a review of representation learning']),
    });
    const result = await checkCitationDoi(citationClaim({ ...realCitation, title: 'Deep learning: a review of representation learning' }), opts);
    expect(result?.status).toBe('supported');
  });

  it('found + clear title mismatch: contradicted, naming the real work', async () => {
    const { opts } = fakeFetch({
      [doiHandleUrl(REAL_DOI)]: handleFound(REAL_DOI),
      [crossrefWorkUrl(REAL_DOI)]: crossrefWork(['Deep learning']),
    });
    const result = await checkCitationDoi(
      citationClaim({ ...realCitation, title: 'Quantum annealing for portfolio optimisation in emerging markets' }), opts);
    expect(result?.status).toBe('contradicted');
    expect(result?.explanation).toContain('This DOI belongs to a different work: "Deep learning"');
    expect(isBillableVerdict(result)).toBe(true);
  });

  it('not found (responseCode 100 on HTTP 404): contradicted, with the handle URL as source, Crossref never called', async () => {
    const { opts, calls } = fakeFetch({ [doiHandleUrl(FAKE_DOI)]: handleMissing(FAKE_DOI) });
    const result = await checkCitationDoi(citationClaim({ title: 'Invented results', doi: FAKE_DOI }), opts);
    expect(result?.status).toBe('contradicted');
    expect(result?.explanation).toContain(`The cited DOI ${FAKE_DOI} does not resolve`);
    expect(result?.sources).toEqual([{ title: `doi.org handle lookup for ${FAKE_DOI}`, uri: `https://doi.org/api/handles/${FAKE_DOI}` }]);
    expect(result?.provenance).toMatchObject({ provider: DOI_RETRIEVER, retriever: DOI_RETRIEVER });
    expect(isBillableVerdict(result)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`https://doi.org/api/handles/${FAKE_DOI}`]);
  });

  it('network error at doi.org: null (normal verify), no verdict invented', async () => {
    const { opts, calls } = fakeFetch({ [doiHandleUrl(REAL_DOI)]: () => { throw new TypeError('fetch failed'); } });
    expect(await checkCitationDoi(citationClaim(realCitation), opts)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('timeout at doi.org: null', async () => {
    const { opts } = fakeFetch({
      [doiHandleUrl(REAL_DOI)]: () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
    });
    expect(await checkCitationDoi(citationClaim(realCitation), opts)).toBeNull();
  });

  it('passes a deadline signal on every request', async () => {
    const { opts, calls } = fakeFetch({
      [doiHandleUrl(REAL_DOI)]: handleFound(REAL_DOI),
      [crossrefWorkUrl(REAL_DOI)]: crossrefWork(['Deep learning']),
    });
    await checkCitationDoi(citationClaim(realCitation), opts);
    for (const c of calls) expect(c.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('doi.org 5xx, a non-JSON reply, a 3xx and an unknown responseCode: null', async () => {
    for (const reply of [
      () => json(503, { responseCode: 1 }),
      () => new Response('<html>busy</html>', { status: 200 }),
      () => new Response(null, { status: 302, headers: { location: 'https://example.org/' } }),
      () => json(200, { responseCode: 2 }),
    ]) {
      const { opts } = fakeFetch({ [doiHandleUrl(REAL_DOI)]: reply });
      expect(await checkCitationDoi(citationClaim(realCitation), opts)).toBeNull();
    }
  });

  it('Crossref 404 (a DOI another agency registered): null', async () => {
    const { opts, calls } = fakeFetch({
      [doiHandleUrl(REAL_DOI)]: handleFound(REAL_DOI),
      [crossrefWorkUrl(REAL_DOI)]: crossrefMissing,
    });
    expect(await checkCitationDoi(citationClaim(realCitation), opts)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('Crossref network error or a record with no title: null', async () => {
    for (const reply of [() => { throw new TypeError('fetch failed'); }, crossrefWork([])]) {
      const { opts } = fakeFetch({ [doiHandleUrl(REAL_DOI)]: handleFound(REAL_DOI), [crossrefWorkUrl(REAL_DOI)]: reply });
      expect(await checkCitationDoi(citationClaim(realCitation), opts)).toBeNull();
    }
  });

  it('a title neither matching nor clearly different: null', async () => {
    const { opts } = fakeFetch({
      [doiHandleUrl(REAL_DOI)]: handleFound(REAL_DOI),
      [crossrefWorkUrl(REAL_DOI)]: crossrefWork(['Deep learning for protein structure prediction']),
    });
    const result = await checkCitationDoi(citationClaim({ ...realCitation, title: 'Deep learning for structure prediction of proteins at scale' }), opts);
    expect(result).toBeNull();
  });

  it('a cited title under 3 words is never called a mismatch', async () => {
    const { opts } = fakeFetch({
      [doiHandleUrl(REAL_DOI)]: handleFound(REAL_DOI),
      [crossrefWorkUrl(REAL_DOI)]: crossrefWork(['Deep learning']),
    });
    expect(await checkCitationDoi(citationClaim({ ...realCitation, title: 'Neural nets' }), opts)).toBeNull();
  });

  it('a resolving DOI with no cited title: null, Crossref not called', async () => {
    const { opts, calls } = fakeFetch({ [doiHandleUrl(REAL_DOI)]: handleFound(REAL_DOI) });
    expect(await checkCitationDoi(citationClaim({ authors: 'LeCun et al.', year: '2015', doi: REAL_DOI }), opts)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('a claim with no DOI, or a DOI that fails normalization: null, no request', async () => {
    const { opts, calls } = fakeFetch({});
    expect(await checkCitationDoi(citationClaim({ title: REAL_TITLE }), opts)).toBeNull();
    expect(await checkCitationDoi(citationClaim({ title: REAL_TITLE, doi: 'see paper' }), opts)).toBeNull();
    expect(await checkCitationDoi({ id: 'f', text: 'A plain fact.', type: 'fact', importance: 3 }, opts)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('privacy: the only scan data sent is the normalized DOI, in the URL path', () => {
  const secretTitle = 'Confidential merger memo for Example Corp';
  const claim: Claim = {
    id: 'user-claim-7',
    text: `The work "${secretTitle}" by Jane Roe (2024), DOI 10.1038/nature14539 exists as cited.`,
    type: 'fact',
    importance: 5,
    citation: { title: secretTitle, authors: 'Jane Roe', year: '2024', venue: 'Internal', doi: 'https://doi.org/10.1038/NATURE14539.', raw: 'Roe, J. (2024).' },
  };

  it('sends exactly the two registry URLs, only the fixed User-Agent, no body', async () => {
    const { opts, calls } = fakeFetch({
      [doiHandleUrl(REAL_DOI)]: handleFound(REAL_DOI),
      [crossrefWorkUrl(REAL_DOI)]: crossrefWork(['Deep learning']),
    });
    await checkCitationDoi(claim, opts);
    expect(calls.map((c) => c.url)).toEqual([
      'https://doi.org/api/handles/10.1038/nature14539',
      'https://api.crossref.org/works/10.1038/nature14539',
    ]);
    for (const { url, init } of calls) {
      expect(new URL(url).search).toBe('');
      expect(new URL(url).hash).toBe('');
      expect(init.headers).toEqual({ 'user-agent': DOI_USER_AGENT });
      expect(init.body).toBeUndefined();
      expect(init.method).toBe('GET');
      const sent = JSON.stringify({ url, headers: init.headers });
      for (const leaked of [secretTitle, 'Jane Roe', 'Roe', 'Internal', 'user-claim-7', 'mailto']) {
        expect(sent).not.toContain(leaked);
      }
    }
    expect(DOI_USER_AGENT).toBe('Faultline (+https://faultline.nxtg.ai)');
  });

  it('calls Crossref only after doi.org answers responseCode 1', async () => {
    for (const reply of [handleMissing(REAL_DOI), () => json(200, { responseCode: 2 })]) {
      const { opts, calls } = fakeFetch({ [doiHandleUrl(REAL_DOI)]: reply });
      await checkCitationDoi(claim, opts);
      expect(calls.map((c) => c.url)).toEqual(['https://doi.org/api/handles/10.1038/nature14539']);
    }
  });

  it('percent-encodes DOI characters that would change the URL, keeping "/" as the separator', () => {
    expect(doiHandleUrl('10.1002/(sici)1097-4636;2-x')).toBe('https://doi.org/api/handles/10.1002/(sici)1097-4636%3B2-x');
  });
});

describe('resolveDoiCheck', () => {
  afterEach(() => {
    resetDefaultDoiCheck();
    vi.unstubAllEnvs();
  });

  it('uses the run override, else the installed default', () => {
    const own: DoiCheckOptions = { fetch: async () => json(200, {}) };
    const installed: DoiCheckOptions = { fetch: async () => json(200, {}) };
    expect(resolveDoiCheck(own)).toBe(own);
    setDefaultDoiCheck(installed);
    expect(resolveDoiCheck()).toBe(installed);
  });

  it('is off for `false` and for FAULTLINE_DOI_CHECK=off, whatever was passed', () => {
    expect(resolveDoiCheck(false)).toBeNull();
    vi.stubEnv('FAULTLINE_DOI_CHECK', 'OFF');
    expect(resolveDoiCheck({ fetch: async () => json(200, {}) })).toBeNull();
    expect(resolveDoiCheck()).toBeNull();
  });
});
