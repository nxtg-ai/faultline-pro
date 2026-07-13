import { describe, it, expect } from 'vitest';
import { consensusVerify, fuseVotes } from '../consensus/consensus_engine';
import type { Claim, ProviderVote, Source } from '../types';
import type { Retriever, LLMProvider } from '../providers/base_provider';

// The EXACT raw blob that leaked into a customer report on 2026-07-13. It must
// never reach a fused verdict OR a providerVote explanation via the consensus
// path (regression: consensus_engine + verifyClaimGrounded had no sanitize +
// never set apiError, so a poisoned consensus report was cacheable — the
// omission Wolf's canonical run caught, uncovered by the single-provider fix).
const PROD_429_LEAK =
  '{"error":{"code":429,"message":"Quota exceeded for metric: ' +
  'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, ' +
  'model: gemini-2.5-flash","status":"RESOURCE_EXHAUSTED"}}';
const LEAK_MARKERS = ['RESOURCE_EXHAUSTED', 'generativelanguage', 'generate_content_free_tier', 'limit: 5', '{'];

const CLAIM: Claim = { id: 'c1', text: 'A test claim', type: 'fact', importance: 3 };
const emptyRetriever: Retriever = { name: 'test-retriever', retrieve: async () => [] as Source[] };

function throwingProvider(name: string): { name: string; provider: LLMProvider } {
  return {
    name,
    provider: {
      verifyClaimGrounded: async () => { throw new Error(PROD_429_LEAK); },
    } as unknown as LLMProvider,
  };
}

function goodProvider(name: string): { name: string; provider: LLMProvider } {
  return {
    name,
    provider: {
      verifyClaimGrounded: async () => ({
        claimId: CLAIM.id, status: 'supported' as const, explanation: 'Holds up.', sources: [],
      }),
    } as unknown as LLMProvider,
  };
}

describe('consensus error path — no raw leak, apiError flagged', () => {
  it('a throwing provider never leaks the raw blob into the vote and sets apiError', async () => {
    const result = await consensusVerify(CLAIM, emptyRetriever, [throwingProvider('gemini')]);
    // fused explanation is clean
    for (const m of LEAK_MARKERS) expect(result.explanation).not.toContain(m);
    // the vote itself is sanitized + flagged
    const vote = result.providerVotes?.[0] as ProviderVote;
    expect(vote.apiError).toBe(true);
    for (const m of LEAK_MARKERS) expect(vote.explanation ?? '').not.toContain(m);
    expect((vote.explanation ?? '').toLowerCase()).toContain('not checked');
    // all-errored → result flagged so caches refuse it
    expect(result.apiError).toBe(true);
  });

  it('a real verdict present → NOT flagged apiError (claim was checked)', async () => {
    const result = await consensusVerify(CLAIM, emptyRetriever, [throwingProvider('gemini'), goodProvider('openai')]);
    expect(result.status).toBe('supported');
    expect(result.apiError).toBeUndefined();
    for (const m of LEAK_MARKERS) expect(result.explanation).not.toContain(m);
  });

  it('fuseVotes: all-errored votes → apiError:true; real verdict → undefined', () => {
    const erroredVote: ProviderVote = { provider: 'gemini', status: 'unverified', sources: [], explanation: 'x', apiError: true };
    expect(fuseVotes(CLAIM, [], [erroredVote]).apiError).toBe(true);

    const realVote: ProviderVote = { provider: 'openai', status: 'supported', sources: [], explanation: 'ok' };
    expect(fuseVotes(CLAIM, [], [realVote]).apiError).toBeUndefined();
  });

  it('all providers genuinely inconclusive (no error) → NOT apiError', () => {
    const inconclusive: ProviderVote = { provider: 'openai', status: 'unverified', sources: [], explanation: 'inconclusive' };
    expect(fuseVotes(CLAIM, [], [inconclusive]).apiError).toBeUndefined();
  });
});
