import type { Claim, VerificationResult, ClaimStatus } from '../types.js';
import type { CritiqueResult } from '../providers/base_provider.js';

/**
 * Verification statuses that indicate a claim needs attention.
 *
 * A claim is considered "failed" if its verification produced one of these
 * outcomes: contradicted by evidence, mixed evidence, or no evidence found.
 */
export const FAILED_STATUSES: ReadonlySet<ClaimStatus> = new Set([
  'contradicted',
  'mixed',
  'unverified',
]);

/**
 * Aggregated critique analysis combining failed-claim extraction
 * with the LLM-generated critique and improved prompt.
 */
export interface CritiqueAnalysis {
  failedClaims: Claim[];
  totalClaims: number;
  totalVerified: number;
  failedCount: number;
  hasCritique: boolean;
  critique: string;
  improvedPrompt: string;
}

/**
 * Extract claims whose verification status indicates failure.
 *
 * A claim is included only when it has a corresponding entry in the
 * verifications record AND that entry's status is in FAILED_STATUSES.
 * Claims without a verification result are excluded (they were never
 * verified, not "failed").
 *
 * @param claims - All extracted claims from the scan
 * @param verifications - Verification results keyed by claim ID
 * @returns Claims that have a failed verification status, in input order
 */
export function extractFailedClaims(
  claims: Claim[],
  verifications: Record<string, VerificationResult>,
): Claim[] {
  return claims.filter((claim) => {
    const verification = verifications[claim.id];
    return verification !== undefined && FAILED_STATUSES.has(verification.status);
  });
}

/**
 * Build a complete critique analysis from scan data and LLM critique output.
 *
 * Combines the failed-claim extraction with counts and the provider's
 * critique/improved-prompt pair into a single analysis object.
 *
 * @param claims - All extracted claims from the scan
 * @param verifications - Verification results keyed by claim ID
 * @param critiqueResult - The critique and improved prompt from the LLM provider
 * @returns Full critique analysis with counts, flags, and passthrough text
 */
export function buildCritiqueAnalysis(
  claims: Claim[],
  verifications: Record<string, VerificationResult>,
  critiqueResult: CritiqueResult,
): CritiqueAnalysis {
  const failedClaims = extractFailedClaims(claims, verifications);

  return {
    failedClaims,
    totalClaims: claims.length,
    totalVerified: Object.keys(verifications).length,
    failedCount: failedClaims.length,
    hasCritique: critiqueResult.critique.trim().length > 0,
    critique: critiqueResult.critique,
    improvedPrompt: critiqueResult.improvedPrompt,
  };
}
