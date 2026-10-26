import type { Claim, VerificationResult, Source } from '../types';
import type { LLMProvider, ImageInput, CritiqueResult, ProviderFactory, RetrievalOutcome, StatusRetriever } from './base_provider';
import { extractClaims, verifyClaim, verifyClaimGrounded, retrieveSources, retrieveSourcesWithStatus, generateCritiqueAndPrompt, GEMINI_MODEL } from '../services/geminiService';

/**
 * Gemini provider — wraps the existing geminiService.ts functions
 * behind the LLMProvider interface.
 *
 * This is a thin adapter: all logic remains in geminiService.ts
 * so that existing App.tsx imports continue to work unchanged.
 */
class GeminiProvider implements LLMProvider {
  readonly name = 'Google Gemini';
  readonly modelId: string;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.modelId = GEMINI_MODEL;
  }

  async extractClaims(text: string, image?: ImageInput): Promise<Claim[]> {
    return extractClaims(text, this.apiKey, image);
  }

  async verifyClaim(claim: Claim): Promise<VerificationResult> {
    return verifyClaim(claim, this.apiKey);
  }

  async verifyClaimGrounded(claim: Claim, sources: Source[]): Promise<VerificationResult> {
    return verifyClaimGrounded(claim, sources, this.apiKey);
  }

  async generateCritiqueAndPrompt(originalText: string, failedClaims: Claim[]): Promise<CritiqueResult> {
    return generateCritiqueAndPrompt(originalText, failedClaims, this.apiKey);
  }
}

export const createGeminiProvider: ProviderFactory = (apiKey: string): LLMProvider => {
  return new GeminiProvider(apiKey);
};

/**
 * Default Retriever: reuses gemini's native googleSearch grounding to fetch
 * sources for a claim. This is the DEFAULT retrieval backend, not the only
 * possible one — a Tavily/Serper/Brave/Custom-Search Retriever can be dropped
 * in as a separate impl selected by config (that seam is the whole point).
 */
export class GeminiGroundingRetriever implements StatusRetriever {
  readonly name = 'gemini-grounding';
  constructor(private apiKey: string) {}

  /** The sources, or [] when the search failed or found nothing. Never throws (the consensus engine relies on that). */
  retrieve(claimText: string): Promise<Source[]> {
    return retrieveSources(claimText, this.apiKey);
  }

  /** The search with how it ended (see RetrievalStatus). Never throws. */
  retrieveWithStatus(claimText: string): Promise<RetrievalOutcome> {
    return retrieveSourcesWithStatus(claimText, this.apiKey);
  }
}
