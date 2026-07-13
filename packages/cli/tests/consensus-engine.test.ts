import { describe, it, expect } from 'vitest';
import {
  consensusVerify,
  fuseVotes,
  type NamedProvider,
} from '../consensus/consensus_engine';
import type { Claim, Source, VerificationResult, ProviderVote, ClaimStatus } from '../types';
import type { LLMProvider, Retriever } from '../providers/base_provider';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLAIM: Claim = { id: 'c1', text: 'The sky is blue.', type: 'fact', importance: 5 };

const SHARED_SOURCES: Source[] = [
  { title: 'Source A', uri: 'https://a.example/1' },
  { title: 'Source B', uri: 'https://b.example/2' },
];

function vote(provider: string, status: ClaimStatus, explanation = 'x'): ProviderVote {
  return { provider, status, sources: SHARED_SOURCES, explanation };
}

/** A mock provider whose grounded verdict is fixed, echoing the shared sources. */
function mockProvider(status: ClaimStatus, name: string): LLMProvider {
  return {
    name,
    modelId: `${name}-mock`,
    async extractClaims() { return []; },
    async verifyClaim(claim: Claim): Promise<VerificationResult> {
      return { claimId: claim.id, status, explanation: `${name}:${status}`, sources: [] };
    },
    async verifyClaimGrounded(claim: Claim, sources: Source[]): Promise<VerificationResult> {
      // Return DIFFERENT sources to prove the engine pins the shared set (LOCK A).
      return {
        claimId: claim.id,
        status,
        explanation: `${name}:${status}`,
        sources: [{ title: 'PROVIDER-OWN', uri: 'https://provider.own/x' }],
      };
    },
    async generateCritiqueAndPrompt() { return { critique: '', improvedPrompt: '' }; },
  };
}

/** A provider that throws from verifyClaimGrounded (simulates claude-on-400). */
function deadProvider(name: string): LLMProvider {
  return {
    name,
    modelId: `${name}-dead`,
    async extractClaims() { return []; },
    async verifyClaim(claim: Claim): Promise<VerificationResult> {
      throw new Error('400 Bad Request');
    },
    async verifyClaimGrounded(): Promise<VerificationResult> {
      throw new Error('400 Bad Request');
    },
    async generateCritiqueAndPrompt() { return { critique: '', improvedPrompt: '' }; },
  };
}

/** A provider with NO grounded method — must be treated as unavailable. */
function ungroundedProvider(name: string): LLMProvider {
  return {
    name,
    modelId: `${name}-ungrounded`,
    async extractClaims() { return []; },
    async verifyClaim(claim: Claim): Promise<VerificationResult> {
      return { claimId: claim.id, status: 'supported', explanation: 'x', sources: [] };
    },
    async generateCritiqueAndPrompt() { return { critique: '', improvedPrompt: '' }; },
  };
}

function named(provider: LLMProvider): NamedProvider {
  return { name: provider.name, provider };
}

const fixedRetriever: Retriever = {
  name: 'mock-retriever',
  async retrieve() { return SHARED_SOURCES; },
};

const emptyRetriever: Retriever = {
  name: 'empty-retriever',
  async retrieve() { return []; },
};

// ── fuseVotes: agreement classification ─────────────────────────────────────

describe('fuseVotes — agreement', () => {
  it('UNANIMOUS: all real verdicts agree', () => {
    const votes = [vote('gemini', 'supported'), vote('openai', 'supported'), vote('claude', 'supported')];
    const r = fuseVotes(CLAIM, SHARED_SOURCES, votes);
    expect(r.status).toBe('supported');
    expect(r.consensus?.agreement).toBe('unanimous');
    expect(r.consensus?.providerCount).toBe(3);
    expect(r.consensus?.dissenting).toBe(0);
  });

  it('MAJORITY: plurality agrees, one dissents', () => {
    const votes = [vote('gemini', 'supported'), vote('openai', 'supported'), vote('claude', 'contradicted')];
    const r = fuseVotes(CLAIM, SHARED_SOURCES, votes);
    expect(r.status).toBe('supported');
    expect(r.consensus?.agreement).toBe('majority');
    expect(r.consensus?.providerCount).toBe(3);
    expect(r.consensus?.dissenting).toBe(1);
  });

  it('SPLIT: even tie between two distinct statuses → mixed', () => {
    const votes = [vote('gemini', 'supported'), vote('openai', 'contradicted')];
    const r = fuseVotes(CLAIM, SHARED_SOURCES, votes);
    expect(r.status).toBe('mixed');
    expect(r.consensus?.agreement).toBe('split');
    expect(r.consensus?.providerCount).toBe(2);
  });
});

// ── LOCK B: providerCount excludes dead/errored providers ───────────────────

describe('fuseVotes — LOCK B (providerCount excludes non-real verdicts)', () => {
  it('excludes unverified/errored votes from providerCount but still lists them', () => {
    const votes = [
      vote('gemini', 'supported'),
      vote('openai', 'supported'),
      vote('claude', 'unverified', 'Provider unavailable: 400'),
    ];
    const r = fuseVotes(CLAIM, SHARED_SOURCES, votes);
    // Only 2 real verdicts count.
    expect(r.consensus?.providerCount).toBe(2);
    // But all 3 are listed for the UI to show "unavailable".
    expect(r.providerVotes).toHaveLength(3);
    expect(r.providerVotes?.find(v => v.provider === 'claude')?.status).toBe('unverified');
    expect(r.consensus?.agreement).toBe('unanimous'); // the 2 real ones agree
  });

  it('all providers dead → status unverified, providerCount 0, sources still shared set', () => {
    const votes = [
      vote('gemini', 'unverified', 'err'),
      vote('openai', 'unverified', 'err'),
    ];
    const r = fuseVotes(CLAIM, SHARED_SOURCES, votes);
    expect(r.status).toBe('unverified');
    expect(r.consensus?.providerCount).toBe(0);
    expect(r.sources).toEqual(SHARED_SOURCES);
    expect(r.providerVotes).toHaveLength(2);
  });
});

// ── LOCK A: sources = shared retrieved set on every vote + top-level ─────────

describe('fuseVotes — LOCK A (shared retrieved set)', () => {
  it('top-level sources equal the shared retrieved set', () => {
    const votes = [vote('gemini', 'supported'), vote('openai', 'mixed')];
    const r = fuseVotes(CLAIM, SHARED_SOURCES, votes);
    expect(r.sources).toEqual(SHARED_SOURCES);
  });

  it('adversarial field is absent (reserved for later)', () => {
    const r = fuseVotes(CLAIM, SHARED_SOURCES, [vote('gemini', 'supported')]);
    expect(r.adversarial).toBeUndefined();
  });
});

// ── consensusVerify: end-to-end with mocked providers + retriever ───────────

describe('consensusVerify — end to end (mocked)', () => {
  it('grounded-by-default: every providerVote.sources = shared retrieved set, not provider-own', async () => {
    const providers = [named(mockProvider('supported', 'gemini')), named(mockProvider('supported', 'openai'))];
    const r = await consensusVerify(CLAIM, fixedRetriever, providers);
    expect(r.sources).toEqual(SHARED_SOURCES);
    expect(r.sources.length).toBeGreaterThan(0); // grounded by construction
    for (const v of r.providerVotes ?? []) {
      // Engine MUST pin shared sources, ignoring the provider's own returned set.
      expect(v.sources).toEqual(SHARED_SOURCES);
      expect(v.sources.find(s => s.uri === 'https://provider.own/x')).toBeUndefined();
    }
  });

  it('a dead provider does NOT abort the scan and is excluded from providerCount (LOCK B)', async () => {
    const providers = [
      named(mockProvider('supported', 'gemini')),
      named(mockProvider('supported', 'openai')),
      named(deadProvider('claude')),
    ];
    const r = await consensusVerify(CLAIM, fixedRetriever, providers);
    expect(r.status).toBe('supported');
    expect(r.consensus?.providerCount).toBe(2); // claude excluded
    expect(r.providerVotes).toHaveLength(3);      // claude still listed
    const claudeVote = r.providerVotes?.find(v => v.provider === 'claude');
    expect(claudeVote?.status).toBe('unverified');
    // Sanitized (2026-07-13 consensus-path fix): the raw provider error is NOT
    // leaked into the vote, apiError flags it as "not checked", no '400' echoed.
    expect(claudeVote?.apiError).toBe(true);
    expect(claudeVote?.explanation).not.toContain('400');
    expect((claudeVote?.explanation ?? '').toLowerCase()).toContain('not checked');
  });

  it('a provider without verifyClaimGrounded is treated as unavailable', async () => {
    const providers = [
      named(mockProvider('contradicted', 'gemini')),
      named(ungroundedProvider('legacy')),
    ];
    const r = await consensusVerify(CLAIM, fixedRetriever, providers);
    expect(r.consensus?.providerCount).toBe(1);
    expect(r.providerVotes?.find(v => v.provider === 'legacy')?.status).toBe('unverified');
  });

  it('empty retrieval still yields a verdict (providers judge against empty shared set)', async () => {
    const providers = [named(mockProvider('mixed', 'gemini')), named(mockProvider('mixed', 'openai'))];
    const r = await consensusVerify(CLAIM, emptyRetriever, providers);
    expect(r.status).toBe('mixed');
    expect(r.consensus?.agreement).toBe('unanimous');
    expect(r.sources).toEqual([]); // honest: no shared evidence retrieved
  });

  it('majority verdict computed across live providers', async () => {
    const providers = [
      named(mockProvider('contradicted', 'gemini')),
      named(mockProvider('contradicted', 'openai')),
      named(mockProvider('supported', 'claude')),
    ];
    const r = await consensusVerify(CLAIM, fixedRetriever, providers);
    expect(r.status).toBe('contradicted');
    expect(r.consensus?.agreement).toBe('majority');
    expect(r.consensus?.dissenting).toBe(1);
  });
});
