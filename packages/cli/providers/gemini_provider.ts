import type { Claim, VerificationResult } from '../types';
import type { LLMProvider, ImageInput, CritiqueResult, ProviderFactory } from './base_provider';
import { extractClaims, verifyClaim, generateCritiqueAndPrompt, GEMINI_MODEL } from '../services/geminiService';

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

  async generateCritiqueAndPrompt(originalText: string, failedClaims: Claim[]): Promise<CritiqueResult> {
    return generateCritiqueAndPrompt(originalText, failedClaims, this.apiKey);
  }
}

export const createGeminiProvider: ProviderFactory = (apiKey: string): LLMProvider => {
  return new GeminiProvider(apiKey);
};
