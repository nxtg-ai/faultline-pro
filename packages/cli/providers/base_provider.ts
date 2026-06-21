import type { Claim, VerificationResult, Source } from '../types';

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
  /**
   * Verify a claim AGAINST a shared, pre-retrieved set of sources (consensus
   * mode). Optional — providers that do not implement this are still usable in
   * the single-provider path; the consensus engine treats their absence as an
   * unavailable vote. Implementations MUST judge using ONLY the supplied
   * `sources` (the shared retrieved set), so every provider in a consensus fan-
   * out reasons over identical evidence.
   *
   * This is an ADDITIVE entry point: it never replaces `verifyClaim`, leaving
   * the single-provider hot path byte-for-byte unchanged.
   */
  verifyClaimGrounded?(claim: Claim, sources: Source[]): Promise<VerificationResult>;
  /** Generate a critique of failed claims and a reinforced prompt. */
  generateCritiqueAndPrompt(originalText: string, failedClaims: Claim[]): Promise<CritiqueResult>;
}

/**
 * Provider-agnostic source retrieval seam.
 *
 * A Retriever fetches grounding sources for a claim INDEPENDENTLY of any single
 * LLM provider. The default implementation (GeminiGroundingRetriever) reuses
 * gemini's native googleSearch grounding, but the whole point of this interface
 * is that a different backend — Tavily, Serper, Brave, Google Custom Search —
 * can be dropped in as a new Retriever impl selected by config, without
 * touching the consensus engine.
 */
export interface Retriever {
  /** Human-readable name (e.g. 'gemini-grounding', 'tavily'). */
  readonly name: string;
  /** Fetch grounding sources for a claim's text. Returns [] when none found. */
  retrieve(claimText: string): Promise<Source[]>;
}

/** Factory function type for creating provider instances. */
export type ProviderFactory = (apiKey: string) => LLMProvider;
