/**
 * Consensus mode at the scan() level — additive opt-in integrity.
 *
 * Pins:
 *  - pipelineConfig.consensus=true routes the VERIFY stage through the consensus
 *    engine and emits the richer verdict shape (consensus + providerVotes).
 *  - When consensus is absent/false, the single-provider verify path runs
 *    UNCHANGED (no consensus/providerVotes fields, no retriever call).
 *  - Grounded-by-default: a consensus verdict carries the shared retrieved
 *    sources.
 *
 * Mocks the provider registry AND the gemini grounding retriever so no live API
 * is hit — determinism per CRUCIBLE Gate 9 unit-test discipline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Claim, VerificationResult, Source } from '../types.js';

const SHARED: Source[] = [{ title: 'Retrieved', uri: 'https://retrieved.example/1' }];

const { mockExtract, mockVerify, mockVerifyGrounded, mockRetrieve } = vi.hoisted(() => ({
  mockExtract: vi.fn(),
  mockVerify: vi.fn(),
  mockVerifyGrounded: vi.fn(),
  mockRetrieve: vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn((_key: string, name?: string) => ({
    name: name ?? 'mock',
    modelId: `${name ?? 'mock'}-v1`,
    extractClaims: mockExtract,
    verifyClaim: mockVerify,
    verifyClaimGrounded: mockVerifyGrounded,
    generateCritiqueAndPrompt: vi.fn().mockResolvedValue({ critique: '', improvedPrompt: '' }),
  })),
}));

vi.mock('../providers/gemini_provider.js', () => ({
  GeminiGroundingRetriever: class {
    name = 'mock-grounding';
    retrieve = mockRetrieve;
  },
}));

import { scan } from '../cli/scan.js';

function claims(n: number): Claim[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    text: `Verifiable factual claim number ${i + 1} about the subject matter.`,
    type: 'fact' as const,
    importance: 4,
  }));
}

function gv(status: VerificationResult['status'], claimId: string): VerificationResult {
  // Provider returns its OWN sources; the engine must override with shared set.
  return { claimId, status, explanation: `g:${status}`, sources: [{ title: 'own', uri: 'https://own/x' }] };
}

describe('scan — consensus mode (additive opt-in)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('consensus=true emits consensus + providerVotes with shared sources (grounded by default)', async () => {
    mockExtract.mockResolvedValue(claims(1));
    mockRetrieve.mockResolvedValue(SHARED);
    mockVerifyGrounded.mockResolvedValue(gv('supported', 'c1'));

    const verdicts: VerificationResult[] = [];
    const r = await scan(
      'A single factual claim about the subject matter.',
      'gemini',
      undefined,
      undefined,
      undefined,
      (_claim, verdict) => verdicts.push(verdict),
      { consensus: true, consensusProviders: ['gemini', 'openai', 'claude'] },
    );

    const verdict = r.verifications['c1'];
    expect(verdict.consensus).toBeDefined();
    expect(verdict.consensus?.agreement).toBe('unanimous');
    expect(verdict.consensus?.providerCount).toBe(3);
    expect(verdict.providerVotes).toHaveLength(3);
    // Grounded-by-default: shared retrieved sources, not provider-own.
    expect(verdict.sources).toEqual(SHARED);
    for (const v of verdict.providerVotes ?? []) {
      expect(v.sources).toEqual(SHARED);
    }
    // Streaming callback carried the richer shape.
    expect(verdicts[0]?.consensus).toBeDefined();
    expect(mockRetrieve).toHaveBeenCalled();
  });

  it('single-provider path (no consensus flag) is UNCHANGED — no consensus fields, no retrieval', async () => {
    mockExtract.mockResolvedValue(claims(1));
    mockVerify.mockResolvedValue({ claimId: 'c1', status: 'supported', explanation: 's', sources: [] });

    const r = await scan('A single factual claim about the subject matter.', 'gemini');

    const verdict = r.verifications['c1'];
    expect(verdict.consensus).toBeUndefined();
    expect(verdict.providerVotes).toBeUndefined();
    expect(mockVerify).toHaveBeenCalled();        // single-provider verify used
    expect(mockVerifyGrounded).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();  // retriever never built when off
  });

  it('consensus survives a dead provider — providerCount excludes it (LOCK B), scan does not throw', async () => {
    mockExtract.mockResolvedValue(claims(1));
    mockRetrieve.mockResolvedValue(SHARED);
    mockVerifyGrounded
      .mockResolvedValueOnce(gv('supported', 'c1'))   // gemini
      .mockResolvedValueOnce(gv('supported', 'c1'))   // openai
      .mockRejectedValueOnce(new Error('400 Bad Request')); // claude dead

    const r = await scan(
      'A single factual claim about the subject matter.',
      'gemini',
      undefined, undefined, undefined, undefined,
      { consensus: true, consensusProviders: ['gemini', 'openai', 'claude'] },
    );

    const verdict = r.verifications['c1'];
    expect(verdict.status).toBe('supported');
    expect(verdict.consensus?.providerCount).toBe(2);  // claude excluded
    expect(verdict.providerVotes).toHaveLength(3);      // claude still listed as unavailable
    expect(verdict.providerVotes?.find(v => v.provider === 'claude')?.status).toBe('unverified');
  });
});
