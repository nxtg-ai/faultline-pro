/**
 * Grounded consensus gives no verdict without a retrieved source, and a search
 * that failed reads as "not checked", never as "checked, found nothing".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consensusVerify, NO_SOURCES_EXPLANATION, type NamedProvider } from '../consensus/consensus_engine';
import { RetrievalError, isRetrievalError } from '../providers/retrieval-error';
import { OpenAIWebSearchRetriever } from '../providers/openai_web_search_retriever';
import { retrieveSources } from '../services/geminiService';
import { isBillableVerdict } from '../lib/verdict-guard';
import type { Claim, ClaimStatus, Source, VerificationResult } from '../types';
import type { LLMProvider, Retriever } from '../providers/base_provider';

const CLAIM: Claim = { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 4 };
const ONE_SOURCE: Source[] = [{ title: 'S', uri: 'https://example.org/s' }];

/** A provider whose grounded verify is a spy, so a test can count the calls. */
function spyProvider(name: string, outcome: ClaimStatus | Error) {
  const verifyClaimGrounded = vi.fn(async (claim: Claim): Promise<VerificationResult> => {
    if (outcome instanceof Error) throw outcome;
    return { claimId: claim.id, status: outcome, explanation: `${name} says ${outcome}`, sources: [] };
  });
  const named: NamedProvider = { name, provider: { name, modelId: `${name}-m1`, verifyClaimGrounded } as unknown as LLMProvider };
  return { named, verifyClaimGrounded };
}

function retrieverOf(retrieve: () => Promise<Source[]>): Retriever {
  return { name: 'test-retriever', retrieve };
}

describe('a failed search: not checked, no votes', () => {
  it('unverified with apiError and the classified reason, zero provider calls, not billable', async () => {
    const a = spyProvider('openai', 'supported');
    const b = spyProvider('claude', 'contradicted');
    const failing = retrieverOf(async () => { throw new RetrievalError('rate_limited'); });
    const r = await consensusVerify(CLAIM, failing, [a.named, b.named]);
    expect(r).toMatchObject({ claimId: 'c1', status: 'unverified', apiError: true, apiErrorReason: 'rate_limited', sources: [] });
    expect(r.explanation).toContain('not checked');
    expect(r.providerVotes).toEqual([]);
    expect(r.consensus).toEqual({ agreement: 'split', providerCount: 0, dissenting: 0 });
    expect(r.provenance).toBeUndefined();
    expect(a.verifyClaimGrounded).not.toHaveBeenCalled();
    expect(b.verifyClaimGrounded).not.toHaveBeenCalled();
    expect(isBillableVerdict(r)).toBe(false);
  });

  it('a retriever that throws a plain error is classified too, and its text never reaches the claim', async () => {
    const a = spyProvider('openai', 'supported');
    const raw = '{"error":"upstream timed out","claim":"The Eiffel Tower is in Paris."}';
    const r = await consensusVerify(CLAIM, retrieverOf(async () => { throw new Error(raw); }), [a.named]);
    expect(r.apiError).toBe(true);
    expect(r.apiErrorReason).toBe('timeout');
    expect(r.explanation).not.toContain('{');
    expect(r.explanation).not.toContain(CLAIM.text);
    expect(a.verifyClaimGrounded).not.toHaveBeenCalled();
  });

  it('end to end: the web search answering 503 means no provider is asked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' } as Response);
    try {
      const a = spyProvider('openai', 'supported');
      const r = await consensusVerify(CLAIM, new OpenAIWebSearchRetriever('k'), [a.named]);
      expect(r).toMatchObject({ status: 'unverified', apiError: true, apiErrorReason: 'provider_unavailable' });
      expect(a.verifyClaimGrounded).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('a search that found nothing: no verdict, no votes', () => {
  it('unverified with the no-source explanation, no apiError, zero provider calls', async () => {
    const a = spyProvider('openai', 'supported');
    const b = spyProvider('claude', 'supported');
    const r = await consensusVerify(CLAIM, retrieverOf(async () => []), [a.named, b.named]);
    expect(r.status).toBe('unverified');
    expect(r.explanation).toBe('No sources were found for this claim, so no verdict was given.');
    expect(NO_SOURCES_EXPLANATION).toBe(r.explanation);
    expect(r.apiError).toBeUndefined();
    expect(r.apiErrorReason).toBeUndefined();
    expect(r.sources).toEqual([]);
    expect(r.providerVotes).toEqual([]);
    expect(r.consensus?.providerCount).toBe(0);
    expect(a.verifyClaimGrounded).not.toHaveBeenCalled();
    expect(b.verifyClaimGrounded).not.toHaveBeenCalled();
  });

  it('a retriever that resolves undefined, null or a non-list reads as no source and does not throw', async () => {
    for (const bad of [undefined, null, { title: 'S', uri: 'https://example.org/s' }]) {
      const a = spyProvider('openai', 'supported');
      const r = await consensusVerify(CLAIM, retrieverOf(async () => bad as unknown as Source[]), [a.named]);
      expect(r).toMatchObject({ claimId: 'c1', status: 'unverified', explanation: NO_SOURCES_EXPLANATION, sources: [] });
      expect(r.apiError).toBeUndefined();
      expect(r.providerVotes).toEqual([]);
      expect(a.verifyClaimGrounded).not.toHaveBeenCalled();
      expect(isBillableVerdict(r)).toBe(false);
    }
  });
});

describe('one source, one provider failing', () => {
  it('the verdict comes from the others, provenance names only them, the failed one is listed as unavailable', async () => {
    const good1 = spyProvider('openai', 'supported');
    const dead = spyProvider('claude', new Error('400 Bad Request'));
    const good2 = spyProvider('gemini', 'supported');
    const r = await consensusVerify(CLAIM, retrieverOf(async () => ONE_SOURCE), [good1.named, dead.named, good2.named]);
    expect(r.status).toBe('supported');
    expect(r.apiError).toBeUndefined();
    expect(r.sources).toEqual(ONE_SOURCE);
    expect(r.consensus).toEqual({ agreement: 'unanimous', providerCount: 2, dissenting: 0 });
    expect(r.provenance?.provider).toBe('consensus');
    expect(r.provenance?.model).toBe('openai:openai-m1+gemini:gemini-m1');
    expect(r.provenance?.model).not.toContain('claude');
    expect(r.provenance?.retriever).toBe('test-retriever');
    expect(r.providerVotes).toHaveLength(3);
    const failed = r.providerVotes!.find((v) => v.provider === 'claude');
    expect(failed).toMatchObject({ status: 'unverified', apiError: true, sources: ONE_SOURCE });
    expect(dead.verifyClaimGrounded).toHaveBeenCalledTimes(1);
    expect(good1.verifyClaimGrounded).toHaveBeenCalledTimes(1);
  });

  it('every provider inconclusive: unverified, checked, and no provenance since no one produced a verdict', async () => {
    const a = spyProvider('openai', 'unverified');
    const r = await consensusVerify(CLAIM, retrieverOf(async () => ONE_SOURCE), [a.named]);
    expect(r.status).toBe('unverified');
    expect(r.apiError).toBeUndefined();
    expect(r.provenance).toBeUndefined();
    expect(a.verifyClaimGrounded).toHaveBeenCalledTimes(1);
  });
});

describe('RetrievalError', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errSpy.mockRestore());

  it('fromError keeps an existing RetrievalError and classifies anything else', () => {
    const own = new RetrievalError('timeout');
    expect(RetrievalError.fromError(own)).toBe(own);
    expect(RetrievalError.fromError(new Error('429 Too Many Requests')).reason).toBe('rate_limited');
    expect(RetrievalError.fromError(new Error('503 overloaded')).reason).toBe('provider_unavailable');
    expect(RetrievalError.fromError('something odd').reason).toBe('provider_error');
  });

  it('both retrievers reject with no key instead of resolving an empty list', async () => {
    await expect(retrieveSources(CLAIM.text, '')).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
    await expect(new OpenAIWebSearchRetriever('').retrieve(CLAIM.text)).rejects.toMatchObject({ name: 'RetrievalError', reason: 'provider_error' });
  });

  it('is recognised by shape, so a second copy of the module still counts', () => {
    const copy = Object.assign(new Error('x'), { name: 'RetrievalError', reason: 'timeout' });
    expect(isRetrievalError(copy)).toBe(true);
    expect(RetrievalError.fromError(copy)).toBe(copy);
    expect(isRetrievalError(new Error('x'))).toBe(false);
  });
});
