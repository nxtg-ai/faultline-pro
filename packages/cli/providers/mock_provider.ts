import type { Claim, VerificationResult } from '../types';
import type { LLMProvider, CritiqueResult, ProviderFactory } from './base_provider';

/**
 * Mock provider — deterministic, offline provider for testing and CI.
 *
 * Splits text into sentence-based claims and returns "supported" for all.
 * No API calls, no external dependencies. Registered in the provider registry
 * as 'mock' so it can be used via --provider mock or .faultlinerc.json.
 */
class MockProvider implements LLMProvider {
  readonly name = 'Mock Provider';
  readonly modelId = 'mock-v1';

  async extractClaims(text: string): Promise<Claim[]> {
    if (!text) return [];
    const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    return sentences.map((s, i) => ({
      id: `c${i + 1}`,
      text: s,
      type: 'fact' as const,
      importance: Math.min(5, 3 + Math.floor(i / 2)),
    }));
  }

  async verifyClaim(claim: Claim): Promise<VerificationResult> {
    return {
      claimId: claim.id,
      status: 'supported' as const,
      explanation: 'Mock verification: supported.',
      sources: [],
    };
  }

  async generateCritiqueAndPrompt(): Promise<CritiqueResult> {
    return {
      critique: 'Mock assessment: stable.',
      improvedPrompt: 'No changes needed.',
    };
  }
}

export const createMockProvider: ProviderFactory = (): LLMProvider => {
  return new MockProvider();
};
