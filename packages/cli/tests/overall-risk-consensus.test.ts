/**
 * Consensus scan path: a claim no voter could check (retrieval found no source)
 * reads unverified, and an all-unverified consensus scan is high risk, never low.
 *
 * Validates: the risk rule in packages/cli/lib/overall-risk.ts on the consensus path.
 * The provider registry and both retrievers are mocked so no live API is hit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Claim, VerificationResult } from '../types.js';

const { mockExtract, mockVerifyGrounded, mockRetrieve } = vi.hoisted(() => ({
  mockExtract: vi.fn(),
  mockVerifyGrounded: vi.fn(),
  mockRetrieve: vi.fn(),
}));

vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn((_key: string, name?: string) => ({
    name: name ?? 'mock',
    modelId: `${name ?? 'mock'}-v1`,
    extractClaims: mockExtract,
    verifyClaim: vi.fn(),
    verifyClaimGrounded: mockVerifyGrounded,
    generateCritiqueAndPrompt: vi.fn().mockResolvedValue({ critique: '', improvedPrompt: '' }),
  })),
}));

vi.mock('../providers/gemini_provider.js', () => ({
  GeminiGroundingRetriever: class { name = 'mock-grounding'; retrieve = mockRetrieve; },
}));

vi.mock('../providers/openai_web_search_retriever.js', () => ({
  OpenAIWebSearchRetriever: class { name = 'mock-openai-web-search'; retrieve = mockRetrieve; },
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

describe('consensus scan — unverified is never low', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('retrieval finds no source for any claim → every verdict unverified → high', async () => {
    mockExtract.mockResolvedValue(claims(2));
    mockRetrieve.mockResolvedValue([]);
    mockVerifyGrounded.mockImplementation(async (claim: Claim): Promise<VerificationResult> => ({
      claimId: claim.id, status: 'supported', explanation: 'no source', sources: [],
    }));

    const r = await scan(
      'Two factual claims about the subject matter.',
      'gemini',
      undefined, undefined, undefined, undefined,
      { consensus: true, consensusProviders: ['gemini', 'openai', 'claude'] },
    );

    const statuses = Object.values(r.verifications).map((v) => v.status);
    expect(statuses).toHaveLength(2);
    expect(statuses.every((s) => s === 'unverified')).toBe(true);
    expect(r.overallRisk).toBe('high');
  });
});
