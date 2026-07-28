/**
 * Verdict mapping — engine `ClaimStatus` → MCP-facing verdict.
 *
 * The engine emits six statuses plus an ORTHOGONAL `apiError` flag. The MCP
 * surface must not flatten that into a three-value enum, because one of the
 * six ('unverified') carries two opposite meanings depending on `apiError`:
 *
 *   apiError=false → "we checked and found no support"   (a real verdict)
 *   apiError=true  → "we never checked" (429/503/network) (NOT a verdict)
 *
 * `packages/cli/types.ts` states the rule directly: "Consumers MUST distinguish
 * the two — silently treating an API failure as an unsupported claim is the
 * failure mode this flag exists to prevent." Collapsing them would let a rate
 * limit render as a caught hallucination, which is precisely the false-verdict
 * class this product exists to catch. So UNCHECKED is a distinct value, and
 * MIXED stays distinct from UNSUPPORTED rather than being rounded down.
 */

import type { ClaimStatus, VerificationResult, Source } from '@nxtg/faultline/types.js';

/**
 * Verdicts exposed over MCP.
 *
 * VERIFIED / REFUTED / UNSUPPORTED are real verdicts — the claim was checked.
 * MIXED is also a real verdict: evidence supports the claim in part and
 * contradicts it in part.
 * UNCHECKED is NOT a verdict. It means verification did not run, or ran on a
 * claim the extractor declined to verify (opinions, non-factual statements).
 */
export type Verdict = 'VERIFIED' | 'REFUTED' | 'UNSUPPORTED' | 'MIXED' | 'UNCHECKED';

/** The subset of verdicts that represent a completed check. */
export const REAL_VERDICTS: readonly Verdict[] = ['VERIFIED', 'REFUTED', 'UNSUPPORTED', 'MIXED'];

/** True when the verdict reflects an actual verification, not a skipped/failed one. */
export function isRealVerdict(v: Verdict): boolean {
  return REAL_VERDICTS.includes(v);
}

/**
 * Map one engine verification to an MCP verdict.
 *
 * `apiError` dominates: whatever status accompanies a provider failure, the
 * honest answer is UNCHECKED. 'loading' should never survive into a completed
 * scan, but if it does it is treated as UNCHECKED rather than guessed at.
 */
export function toVerdict(status: ClaimStatus, apiError?: boolean): Verdict {
  if (apiError) return 'UNCHECKED';

  switch (status) {
    case 'supported':
      return 'VERIFIED';
    case 'contradicted':
      return 'REFUTED';
    case 'mixed':
      return 'MIXED';
    case 'unverified':
      // Genuinely checked, no supporting evidence found.
      return 'UNSUPPORTED';
    case 'skipped':
    case 'loading':
      return 'UNCHECKED';
  }
}

/** A single claim as presented over MCP. */
export interface ClaimVerdict {
  claim: string;
  verdict: Verdict;
  /** First supporting/contradicting source URL, when the verifier returned one. */
  evidence_url?: string;
  /** Every source URL the verdict was grounded in. */
  evidence_urls: string[];
  /** The verifier's explanation. */
  note: string;
  /**
   * True when this specific claim could not be checked because the provider
   * errored. Distinct from a claim that was checked and found unsupported.
   */
  unchecked_reason?: 'provider_error' | 'not_verifiable';
}

function firstUri(sources: Source[] | undefined): string | undefined {
  const uri = sources?.find((s) => typeof s?.uri === 'string' && s.uri.length > 0)?.uri;
  return uri || undefined;
}

/** Build the MCP-facing claim entry from an engine claim + its verification. */
export function toClaimVerdict(
  claimText: string,
  verification: VerificationResult | undefined,
): ClaimVerdict {
  // No verification record at all — the claim was extracted but never verified.
  if (!verification) {
    return {
      claim: claimText,
      verdict: 'UNCHECKED',
      evidence_urls: [],
      note: 'No verification was performed for this claim.',
      unchecked_reason: 'not_verifiable',
    };
  }

  const verdict = toVerdict(verification.status, verification.apiError);
  const sources = Array.isArray(verification.sources) ? verification.sources : [];
  const evidence_urls = sources
    .map((s) => s?.uri)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);

  const entry: ClaimVerdict = {
    claim: claimText,
    verdict,
    evidence_urls,
    note: verification.explanation ?? '',
  };

  const evidence_url = firstUri(sources);
  if (evidence_url) entry.evidence_url = evidence_url;

  if (verdict === 'UNCHECKED') {
    entry.unchecked_reason = verification.apiError ? 'provider_error' : 'not_verifiable';
  }

  return entry;
}

/**
 * Risk score, 0-100, derived from the engine's own `overallRisk` band.
 *
 * Higher means more risk. This is a presentation of the engine's band, not a
 * second opinion — the engine remains the single scorer (spec: wrapper-only).
 */
const RISK_SCORE: Record<string, number> = {
  low: 15,
  medium: 45,
  high: 75,
  critical: 95,
};

export function toRiskScore(overallRisk: string): number {
  return RISK_SCORE[overallRisk] ?? 50;
}
