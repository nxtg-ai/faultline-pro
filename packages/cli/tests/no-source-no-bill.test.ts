/**
 * No source, no bill; a failed search is an error, never an empty result.
 *
 * - A claim is billable only when its verdict is supported, contradicted or
 *   mixed, it carries at least one source, the engine bound a retriever to it,
 *   and it is not an API error.
 * - The OpenAI web search and the Gemini consensus search reject a reply that
 *   says the search failed or was blocked, instead of resolving no sources.
 * - fuseVotes never returns a definite verdict without a source.
 * - The default Gemini verify path (consensus off) is unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Claim, VerificationResult } from '../types';

const sdk = vi.hoisted(() => ({ reply: {} as Record<string, unknown> }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: async () => ({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, ...sdk.reply }) };
  },
}));

import { isBillableVerdict, billableVerdictCount } from '../lib/verdict-guard';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever';
import { retrieveSources, verifyClaim } from '../services/geminiService';
import { fuseVotes, consensusVerify, type NamedProvider } from '../consensus/consensus_engine';
import type { LLMProvider, Retriever } from '../providers/base_provider';
import { buildFullVerificationSummary } from '../cli/full-scan';

const CLAIM: Claim = { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 4 };
const SOURCE = { title: 'S', uri: 'https://example.org/s' };
/**
 * Provenance as the engine binds it for a Gemini grounded call. Every fixture
 * below carries it, so each test turns on the one condition it names; a
 * verdict without an engine retriever is never billable.
 */
const BOUND = {
  provenance: { provider: 'gemini', model: 'gemini-test', verifiedAt: '2026-10-01T00:00:00.000Z', retriever: 'gemini-grounding', retrievedAt: '2026-10-01T00:00:00.000Z' },
};

describe('isBillableVerdict: no source, no bill', () => {
  it('a definite verdict with a source is billable, each of the three', () => {
    for (const status of ['supported', 'contradicted', 'mixed']) {
      expect(isBillableVerdict({ ...BOUND, status, sources: [SOURCE] })).toBe(true);
    }
  });

  it('a definite verdict with no source is not billable', () => {
    for (const status of ['supported', 'contradicted', 'mixed']) {
      expect(isBillableVerdict({ ...BOUND, status, sources: [] })).toBe(false);
      expect(isBillableVerdict({ ...BOUND, status })).toBe(false);
      expect(isBillableVerdict({ ...BOUND, status, sources: 'https://example.org/s' })).toBe(false);
    }
  });

  it('unverified is never billable, with or without a source', () => {
    expect(isBillableVerdict({ ...BOUND, status: 'unverified', sources: [SOURCE] })).toBe(false);
    expect(isBillableVerdict({ ...BOUND, status: 'unverified', sources: [] })).toBe(false);
  });

  it('an API error is never billable, even with a source', () => {
    expect(isBillableVerdict({ ...BOUND, status: 'supported', sources: [SOURCE], apiError: true })).toBe(false);
  });

  it('billableVerdictCount counts only sourced definite verdicts', () => {
    const v = {
      a: { ...BOUND, status: 'supported', sources: [SOURCE] },
      b: { ...BOUND, status: 'supported', sources: [] },
      c: { ...BOUND, status: 'unverified', sources: [SOURCE] },
      d: { ...BOUND, status: 'mixed', sources: [SOURCE] },
    };
    expect(Object.keys(v).length).toBe(4);
    expect(billableVerdictCount(v)).toBe(2);
  });

  it('the full-scan summary serves only billable claims', () => {
    const facts: Claim[] = ['f1', 'f2', 'f3', 'f4'].map((id) => ({ id, text: id, type: 'fact', importance: 3 }));
    const results: Array<VerificationResult | undefined> = [
      { ...BOUND, claimId: 'f1', status: 'supported', explanation: '', sources: [SOURCE] },
      { ...BOUND, claimId: 'f2', status: 'supported', explanation: '', sources: [] },
      { ...BOUND, claimId: 'f3', status: 'unverified', explanation: '', sources: [SOURCE] },
      undefined,
    ];
    const s = buildFullVerificationSummary({ facts, notCheckable: [] }, results);
    expect(s.servedClaims).toBe(1);
    expect(s.unservedClaimIds).toEqual(['f2', 'f3']);
    expect(s.uncheckedClaimIds).toEqual(['f4']);
  });
});

describe('OpenAI web search: a failed reply is a failed search', () => {
  const fetchOk = (body: unknown) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: async () => body } as Response);
  const withCitation = {
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: 'Paris.', annotations: [{ type: 'url_citation', url: SOURCE.uri, title: 'S', start_index: 0, end_index: 6 }] }],
    }],
    usage: {},
  };
  afterEach(() => vi.restoreAllMocks());

  it('HTTP 200 with status failed rejects, and its partial citations never come back', async () => {
    fetchOk({ ...withCitation, status: 'failed', error: { code: 'server_error', message: 'The search failed.' } });
    await expect(new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text)).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
  });

  it('status failed with a rate-limit error classifies as rate_limited', async () => {
    fetchOk({ output: [], status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached.' } });
    await expect(new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text)).rejects.toMatchObject({ name: 'RetrievalError', reason: 'rate_limited' });
  });

  it('status incomplete for a reason other than output length rejects', async () => {
    fetchOk({ ...withCitation, status: 'incomplete', incomplete_details: { reason: 'content_filter' } });
    await expect(new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text)).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
  });

  it('status incomplete at the output limit still reads as output_truncated', async () => {
    fetchOk({ ...withCitation, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    await expect(new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text)).rejects.toMatchObject({ name: 'RetrievalError', reason: 'output_truncated' });
  });

  it('a failed search reaches no voter through consensus', async () => {
    fetchOk({ ...withCitation, status: 'failed' });
    const verifyClaimGrounded = vi.fn(async () => ({ claimId: 'c1', status: 'supported', explanation: 'x', sources: [] }));
    const voter: NamedProvider = { name: 'openai', provider: { name: 'openai', modelId: 'm', verifyClaimGrounded } as unknown as LLMProvider };
    const r = await consensusVerify(CLAIM, new OpenAIWebSearchRetriever('k'), [voter]);
    expect(r).toMatchObject({ status: 'unverified', apiError: true, sources: [] });
    expect(verifyClaimGrounded).not.toHaveBeenCalled();
    expect(isBillableVerdict(r)).toBe(false);
  });

  it('status cancelled rejects, and its citations never come back', async () => {
    fetchOk({ ...withCitation, status: 'cancelled' });
    await expect(new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text)).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
  });

  it('status in_progress rejects: only a completed search is read', async () => {
    fetchOk({ ...withCitation, status: 'in_progress' });
    await expect(new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text)).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
  });

  it('an error object with no status rejects, classified by its code', async () => {
    fetchOk({ ...withCitation, error: { code: 'server_error', message: 'The search failed.' } });
    await expect(new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text)).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
    vi.restoreAllMocks();
    fetchOk({ output: [], error: { code: 'rate_limit_exceeded', message: 'Rate limit reached.' } });
    await expect(new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text)).rejects.toMatchObject({ name: 'RetrievalError', reason: 'rate_limited' });
  });

  it('no status and no error object (or error: null) still resolves its sources', async () => {
    fetchOk(withCitation);
    const bare = await new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text);
    expect(bare.length).toBe(1);
    vi.restoreAllMocks();
    fetchOk({ ...withCitation, error: null });
    const nullError = await new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text);
    expect(nullError.length).toBe(1);
    expect(nullError[0].uri).toBe(SOURCE.uri);
  });

  it('status completed with citations still resolves its sources', async () => {
    fetchOk({ ...withCitation, status: 'completed' });
    const sources = await new OpenAIWebSearchRetriever('k').retrieve(CLAIM.text);
    expect(sources.length).toBe(1);
    expect(sources[0].uri).toBe(SOURCE.uri);
  });
});

describe('Gemini consensus search: a blocked or empty reply is a failed search', () => {
  const chunk = { web: { title: 'G', uri: 'https://example.org/g' } };
  let errSpy: ReturnType<typeof vi.spyOn>;
  afterEach(() => errSpy?.mockRestore());
  const quiet = () => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); };

  it('promptFeedback.blockReason rejects', async () => {
    quiet();
    sdk.reply = { text: '', promptFeedback: { blockReason: 'SAFETY' }, candidates: [{ finishReason: 'STOP', groundingMetadata: { groundingChunks: [chunk] } }] };
    await expect(retrieveSources(CLAIM.text, 'k')).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
  });

  it('no candidates rejects', async () => {
    quiet();
    sdk.reply = { text: '' };
    await expect(retrieveSources(CLAIM.text, 'k')).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
    sdk.reply = { text: '', candidates: [] };
    await expect(retrieveSources(CLAIM.text, 'k')).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
  });

  it('a finishReason other than STOP or MAX_TOKENS rejects', async () => {
    quiet();
    for (const finishReason of ['SAFETY', 'RECITATION', 'OTHER', 'BLOCKLIST']) {
      sdk.reply = { text: 'x', candidates: [{ finishReason, groundingMetadata: { groundingChunks: [chunk] } }] };
      await expect(retrieveSources(CLAIM.text, 'k')).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
    }
  });

  it('STOP with no grounding chunks is a search that ran and found nothing', async () => {
    sdk.reply = { text: 'Nothing found.', candidates: [{ finishReason: 'STOP' }] };
    expect(await retrieveSources(CLAIM.text, 'k')).toEqual([]);
  });

  it('STOP with chunks resolves the sources', async () => {
    sdk.reply = { text: 'Found.', candidates: [{ finishReason: 'STOP', groundingMetadata: { groundingChunks: [chunk] } }] };
    expect(await retrieveSources(CLAIM.text, 'k')).toEqual([{ title: 'G', uri: 'https://example.org/g' }]);
  });
});

describe('fuseVotes: no definite verdict without a source', () => {
  const vote = (provider: string, status: 'supported' | 'contradicted' | 'mixed') =>
    ({ provider, status, explanation: `${provider} says ${status}`, sources: [] });

  it('unanimous supported votes over zero sources fuse to unverified', () => {
    const votes = [vote('openai', 'supported'), vote('claude', 'supported')];
    const r = fuseVotes(CLAIM, [], votes);
    expect(r.status).toBe('unverified');
    expect(r.sources).toEqual([]);
    expect(r.apiError).toBeUndefined();
    expect(r.providerVotes).toHaveLength(2);
    expect(isBillableVerdict(r)).toBe(false);
  });

  it('contradicted and a split (mixed) over zero sources fuse to unverified too', () => {
    expect(fuseVotes(CLAIM, [], [vote('openai', 'contradicted')]).status).toBe('unverified');
    expect(fuseVotes(CLAIM, [], [vote('openai', 'supported'), vote('claude', 'contradicted')]).status).toBe('unverified');
  });

  it('the same votes with one source keep their verdict', () => {
    const r = fuseVotes(CLAIM, [SOURCE], [vote('openai', 'supported'), vote('claude', 'supported')]);
    expect(r.status).toBe('supported');
    expect(r.sources).toEqual([SOURCE]);
    // fuseVotes alone binds no provenance; consensusVerify adds the retriever
    // (next test), so the fused verdict by itself is not yet billable.
    expect(r.provenance).toBeUndefined();
    expect(isBillableVerdict(r)).toBe(false);
    expect(isBillableVerdict({ ...r, ...BOUND })).toBe(true);
  });

  it('consensusVerify with a retriever that returns sources is unaffected', async () => {
    const retriever: Retriever = { name: 'r', retrieve: async () => [SOURCE] };
    const verifyClaimGrounded = vi.fn(async () => ({ claimId: 'c1', status: 'supported' as const, explanation: 'x', sources: [] }));
    const voter: NamedProvider = { name: 'openai', provider: { name: 'openai', modelId: 'm', verifyClaimGrounded } as unknown as LLMProvider };
    const r = await consensusVerify(CLAIM, retriever, [voter]);
    expect(r.status).toBe('supported');
    expect(r.sources).toEqual([SOURCE]);
    // The consensus engine names its own retriever, so the verdict is billable.
    expect(r.provenance?.retriever).toBe('r');
    expect(isBillableVerdict(r)).toBe(true);
  });
});

describe('default Gemini verify path (consensus off): unchanged', () => {
  afterEach(() => vi.useRealTimers());

  it('a grounded mocked reply gives the same bytes as before this change', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
    sdk.reply = {
      text: '```json\n{"status":"supported","explanation":"The tower stands in Paris."}\n```',
      modelVersion: 'gemini-test-001',
      candidates: [{
        finishReason: 'STOP',
        groundingMetadata: {
          groundingChunks: [
            { web: { title: 'Tower', uri: 'https://example.org/tower' } },
            { web: { title: 'Paris', uri: 'https://example.org/paris' } },
          ],
          searchEntryPoint: { renderedContent: '<div>chip</div>' },
          webSearchQueries: ['eiffel tower location'],
        },
      }],
    };
    const r = await verifyClaim(CLAIM, 'k');
    // Recorded from the code before this change.
    expect(JSON.stringify(r)).toBe(RECORDED_VERIFY_BYTES);
  });
});

const RECORDED_VERIFY_BYTES =
  '{"claimId":"c1","status":"supported","explanation":"The tower stands in Paris.","sources":[{"title":"Tower","uri":"https://example.org/tower"},{"title":"Paris","uri":"https://example.org/paris"}],"searchEntryPoint":{"renderedContent":"<div>chip</div>"},"webSearchQueries":["eiffel tower location"],"provenance":{"provider":"gemini","model":"gemini-test-001","verifiedAt":"2026-10-01T12:00:00.000Z","retriever":"gemini-grounding","retrievedAt":"2026-10-01T12:00:00.000Z"}}';
