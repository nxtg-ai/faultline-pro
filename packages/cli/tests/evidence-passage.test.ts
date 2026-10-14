// Validates: N-234 (evidence passage from fetched page bytes, GoPMO 1.18.11.3 P1b; EP4 recert 02-codex-evidence.md row 3)
/**
 * The passage comes from the page that was fetched, never from the model's
 * reply, and carries the fetch time and a hash of the bytes read.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import {
  attachEvidence,
  contentTokens,
  fetchSourceEvidence,
  isGeminiGroundingSource,
  htmlToText,
  pickPassage,
  type EvidenceFetch,
} from '../evidence/passage.js';
import { scan } from '../cli/scan.js';
import { registerProvider } from '../providers/registry.js';
import type { Claim, VerificationResult } from '../types.js';

const CLAIM_TEXT = 'The Eiffel Tower was completed in 1889.';
const PAGE = `<!doctype html><html><head><title>Kestrelvane</title><script>var x = "Eiffel Tower completed 1889 in script";</script></head>
<body><nav>Home &amp; about</nav><p>Gustave Eiffel's company designed the structure.</p>
<p>Construction finished in March 1889, and the Eiffel Tower was completed in time for the World&#39;s Fair.</p>
<p>It is 330 metres tall.</p></body></html>`;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function htmlResponse(body: string, init: { status?: number; type?: string; url?: string } = {}): Response {
  const res = new Response(body, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'text/html; charset=utf-8' } });
  if (init.url) Object.defineProperty(res, 'url', { value: init.url });
  return res;
}

const fetchOf = (fn: (url: string) => Response | Promise<Response>): EvidenceFetch => vi.fn(async (url: string) => fn(url));

describe('text and matching', () => {
  it('htmlToText drops script, style and head, decodes entities and keeps visible text', () => {
    const t = htmlToText(PAGE);
    expect(t).not.toContain('in script');
    expect(t).not.toContain('Kestrelvane');
    expect(t).toContain('Home & about');
    expect(t).toContain("World's Fair");
    expect(t).not.toMatch(/<|>/);
  });

  it('contentTokens keeps numbers and drops stopwords and short words', () => {
    expect(contentTokens('The Eiffel Tower was completed in 1889.')).toEqual(['eiffel', 'tower', 'completed', '1889']);
  });

  it('pickPassage returns the best-matching page sentence', () => {
    const p = pickPassage(htmlToText(PAGE), CLAIM_TEXT);
    expect(p).toBe("Construction finished in March 1889, and the Eiffel Tower was completed in time for the World's Fair.");
  });

  it('pickPassage skips navigation crumbs and template or JSON text, and prefers the sentence with the claim\'s number', () => {
    const page = [
      'Hoover Dam. Home .',
      '"},"map_caption":{"wt":"Eiffel Tower completed 1889"},"location":{"wt":"[[Paris]]"}.',
      'The Eiffel Tower is a wrought-iron lattice tower that was completed for the fair in Paris.',
      'Work on the Eiffel Tower was completed in 1889 after two years of construction in Paris.',
    ].join(' ');
    expect(pickPassage(page, CLAIM_TEXT)).toBe('Work on the Eiffel Tower was completed in 1889 after two years of construction in Paris.');
    expect(pickPassage('Eiffel Tower. Home. Completed 1889 .', CLAIM_TEXT)).toBeNull();
  });

  it('pickPassage returns null when nothing on the page matches enough', () => {
    expect(pickPassage('Bananas are yellow. Apples are red.', CLAIM_TEXT)).toBeNull();
    expect(pickPassage('The tower is tall.', CLAIM_TEXT)).toBeNull();
  });

  it('pickPassage caps a long passage at 400 characters with an ellipsis', () => {
    const long = `Eiffel Tower completed 1889 ${'and more words follow here '.repeat(40)}.`;
    const p = pickPassage(long, CLAIM_TEXT)!;
    expect(p.length).toBeLessThanOrEqual(401);
    expect(p.endsWith('…')).toBe(true);
  });
});

describe('fetchSourceEvidence', () => {
  const source = { title: 'Kestrelvane', uri: 'https://links.example/r/abc' };

  it('refuses a Google grounding Link itself, without a request (defense in depth)', async () => {
    const f = fetchOf(() => htmlResponse(PAGE));
    const ev = await fetchSourceEvidence({ title: 'g', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc' }, CLAIM_TEXT, { fetch: f });
    expect(ev).toEqual({ status: 'not_fetched', reason: 'provider_terms', passage: null });
    expect(f).not.toHaveBeenCalled();
  });

  it('reads the page, hashes the bytes and records the final URL and fetch time', async () => {
    const before = Date.now();
    const f = fetchOf(() => htmlResponse(PAGE, { url: 'https://kestrelvane.example/eiffel' }));
    const ev = await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: f });
    expect(ev.status).toBe('ok');
    expect(ev.passage).toContain('Eiffel Tower was completed in time');
    expect(ev.finalUri).toBe('https://kestrelvane.example/eiffel');
    expect(ev.httpStatus).toBe(200);
    expect(ev.contentSha256).toBe(createHash('sha256').update(PAGE).digest('hex'));
    expect(ev.fetchedAt).toMatch(ISO);
    expect(Date.parse(ev.fetchedAt)).toBeGreaterThanOrEqual(before);
    const init = (f as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/^FaultlineEvidence\//);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a page with no matching sentence is no_match with a null passage, not an invented one', async () => {
    const ev = await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: fetchOf(() => htmlResponse('<p>Unrelated page about bananas.</p>')) });
    expect(ev).toMatchObject({ status: 'no_match', passage: null });
    expect(ev.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('non-2xx is http_error', async () => {
    const ev = await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: fetchOf(() => htmlResponse('gone', { status: 404 })) });
    expect(ev).toMatchObject({ status: 'http_error', passage: null, httpStatus: 404 });
  });

  it('a PDF or image is unsupported_type', async () => {
    const ev = await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: fetchOf(() => htmlResponse('%PDF-1.7', { type: 'application/pdf' })) });
    expect(ev).toMatchObject({ status: 'unsupported_type', passage: null });
  });

  it('a refused address is blocked; a network error or timeout is fetch_failed', async () => {
    const blockedErr = Object.assign(new Error('Outbound URL blocked: private address'), { name: 'OutboundUrlBlockedError' });
    expect((await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: fetchOf(() => { throw blockedErr; }) })).status).toBe('blocked');
    expect((await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: fetchOf(() => { throw new TypeError('fetch failed'); }) })).status).toBe('fetch_failed');
    const slow: EvidenceFetch = (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError'))));
    expect((await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: slow, timeoutMs: 30 })).status).toBe('fetch_failed');
  });

  it('a non-http URL is blocked without a fetch', async () => {
    const f = fetchOf(() => htmlResponse(PAGE));
    expect((await fetchSourceEvidence({ title: 'x', uri: 'file:///etc/passwd' }, CLAIM_TEXT, { fetch: f })).status).toBe('blocked');
    expect(f).not.toHaveBeenCalled();
  });

  it('reads at most maxBytes and says the page was truncated', async () => {
    const big = `<p>The Eiffel Tower in Paris was completed in 1889 for the fair.</p>${'x'.repeat(5000)}`;
    const ev = await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: fetchOf(() => htmlResponse(big)), maxBytes: 1000 });
    expect(ev.truncated).toBe(true);
    expect(ev.contentSha256).toBe(createHash('sha256').update(big.slice(0, 1000)).digest('hex'));
    expect(ev.status).toBe('ok');
  });
});

describe('attachEvidence', () => {
  const verdict = (over: Partial<VerificationResult> = {}): VerificationResult => ({
    claimId: 'c1', status: 'supported',
    // The model's reply names a phrase the page does not contain: it must not become the passage.
    explanation: 'Model says: the tower opened on 31 March 1889 to great acclaim.',
    sources: [{ title: 'A', uri: 'https://a.example/1' }, { title: 'B', uri: 'https://b.example/2' }],
    ...over,
  });

  it('fetches every cited source in parallel and never changes status or explanation', async () => {
    const f = fetchOf((url) => url.includes('a.example') ? htmlResponse(PAGE) : htmlResponse('<p>Nothing relevant.</p>'));
    const v = await attachEvidence(verdict(), CLAIM_TEXT, { fetch: f });
    expect(f).toHaveBeenCalledTimes(2);
    expect(v.status).toBe('supported');
    expect(v.explanation).toBe(verdict().explanation);
    expect(v.sources[0].evidence!.status).toBe('ok');
    expect(v.sources[0].evidence!.passage).not.toContain('great acclaim');
    expect(v.sources[1].evidence).toMatchObject({ status: 'no_match', passage: null });
  });

  it('a verdict whose check never ran, or that cites nothing, is returned as given with no fetch', async () => {
    const f = fetchOf(() => htmlResponse(PAGE));
    const errored = verdict({ apiError: true, status: 'unverified' });
    expect(await attachEvidence(errored, CLAIM_TEXT, { fetch: f })).toBe(errored);
    const bare = verdict({ sources: [] });
    expect(await attachEvidence(bare, CLAIM_TEXT, { fetch: f })).toBe(bare);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('Gemini grounding Links are never fetched (provider terms)', () => {
  const GROUNDED = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc';
  const base: VerificationResult = { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] };

  it('a gemini-grounding verdict marks every source not_fetched / provider_terms and sends no request', async () => {
    const f = fetchOf(() => htmlResponse(PAGE));
    const v = await attachEvidence({
      ...base,
      sources: [{ title: 'a', uri: GROUNDED }, { title: 'b', uri: 'https://plain.example/x' }],
      provenance: { provider: 'gemini', model: 'm', verifiedAt: 'T', retriever: 'gemini-grounding', retrievedAt: 'T' },
    }, CLAIM_TEXT, { fetch: f });
    expect(f).not.toHaveBeenCalled();
    for (const s of v.sources) expect(s.evidence).toEqual({ status: 'not_fetched', reason: 'provider_terms', passage: null });
  });

  it('a grounding redirect link is not fetched even without provenance; other links still are', async () => {
    const f = fetchOf(() => htmlResponse(PAGE));
    const v = await attachEvidence({ ...base, sources: [{ title: 'a', uri: GROUNDED }, { title: 'b', uri: 'https://plain.example/x' }] }, CLAIM_TEXT, { fetch: f });
    expect(v.sources[0].evidence).toEqual({ status: 'not_fetched', reason: 'provider_terms', passage: null });
    expect(v.sources[1].evidence!.status).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
    expect((f as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('https://plain.example/x');
  });

  it('isGeminiGroundingSource: consensus with an OpenAI retriever is not Gemini', () => {
    const consensus = { ...base, provenance: { provider: 'consensus', model: 'x', verifiedAt: 'T', retriever: 'openai-web-search', retrievedAt: 'T' } };
    expect(isGeminiGroundingSource(consensus, { title: 't', uri: 'https://plain.example/x' })).toBe(false);
    expect(isGeminiGroundingSource(consensus, { title: 't', uri: GROUNDED })).toBe(true);
    expect(isGeminiGroundingSource(base, { title: 't', uri: 'not a url' })).toBe(false);
  });
});

describe('through scan()', () => {
  let savedKey: string | undefined;
  beforeAll(() => { savedKey = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'fixture-unused'; });
  afterAll(() => { if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey; });

  it('evidence is attached before the claim is reported, and only when asked for', async () => {
    registerProvider('evidence-fixture', () => ({
      name: 'Evidence fixture',
      modelId: 'fixture-v1',
      extractClaims: async (): Promise<Claim[]> => [{ id: 'c1', text: CLAIM_TEXT, type: 'fact', importance: 5 }],
      verifyClaim: async (c: Claim) => ({ claimId: c.id, status: 'supported', explanation: 'ok', sources: [{ title: 'A', uri: 'https://a.example/1' }] }),
      generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
    }) as never);
    const f = fetchOf(() => htmlResponse(PAGE));
    const seen: VerificationResult[] = [];
    const r = await scan(CLAIM_TEXT, 'evidence-fixture', undefined, undefined, undefined, (_c, v) => { seen.push(v); }, undefined, { evidence: { fetch: f } });
    expect(seen).toHaveLength(1);
    expect(seen[0].sources[0].evidence!.status).toBe('ok');
    expect(r.verifications.c1.sources[0].evidence!.passage).toContain('Eiffel Tower was completed');

    const plain = await scan(CLAIM_TEXT, 'evidence-fixture');
    expect(plain.verifications.c1.sources[0].evidence).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
