import type { Claim, VerificationResult } from '../types';

export interface ImageInput {
  /** Base64-encoded image data. */
  data: string;
  /** MIME type (e.g. 'image/png', 'image/jpeg'). */
  mimeType: string;
}

export interface CritiqueResult {
  critique: string;
  improvedPrompt: string;
}

/**
 * Common interface all LLM providers must implement.
 */
export interface LLMProvider {
  /** Display name (e.g. 'Google Gemini'). */
  readonly name: string;
  /** Model identifier used for API calls. */
  readonly modelId: string;
  /** Extract atomic claims from text (and optional image). */
  extractClaims(text: string, image?: ImageInput): Promise<Claim[]>;
  /** Verify a single claim and return its status + explanation. */
  verifyClaim(claim: Claim): Promise<VerificationResult>;
  /** Generate a critique of failed claims and a reinforced prompt. */
  generateCritiqueAndPrompt(originalText: string, failedClaims: Claim[]): Promise<CritiqueResult>;
}

/** Factory function type for creating provider instances. */
export type ProviderFactory = (apiKey: string) => LLMProvider;
