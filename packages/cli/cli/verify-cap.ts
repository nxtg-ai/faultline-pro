import type { Claim } from '../types.js';
import { isCitationClaim } from '../lib/citation.js';

/**
 * How many claims one scan sends to the verify stage. Every verified claim is a
 * grounded provider call, so this cap bounds the cost of a scan. Callers that
 * pass no cap (the CLI, every API route that does not resolve a tier) get this.
 */
export const DEFAULT_VERIFY_CAP = 8;

/**
 * Normalise a requested cap. Anything that is not a finite integer >= 1 falls
 * back to DEFAULT_VERIFY_CAP, so a bad table entry can never turn verification
 * off (0) or remove the cost bound (Infinity / NaN).
 *
 * @example
 *   resolveVerifyCap(3)        // 3
 *   resolveVerifyCap(0)        // 8
 *   resolveVerifyCap(Infinity) // 8
 */
export function resolveVerifyCap(cap: unknown): number {
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1) {
    return DEFAULT_VERIFY_CAP;
  }
  return cap;
}

/**
 * A claim is worth verifying when it is a fact of importance 2 or higher, or
 * a citation claim (a fact naming a cited work) of any importance: whether a
 * cited work exists is always checkable (N-237).
 */
export function isEligibleForVerification(claim: Claim): boolean {
  return claim.type === 'fact' && (claim.importance >= 2 || isCitationClaim(claim));
}

/**
 * Eligible claims in verification order: citation claims first, then by
 * importance, most important first (stable sort keeps extraction order on
 * ties). Citations lead so that a reference list is checked one claim per
 * reference before ordinary facts fill the cap; they still count toward it.
 */
export function rankEligibleClaims(claims: Claim[]): Claim[] {
  const citationRank = (c: Claim): number => (isCitationClaim(c) ? 1 : 0);
  return claims
    .filter(isEligibleForVerification)
    .sort((a, b) => citationRank(b) - citationRank(a) || b.importance - a.importance);
}

/**
 * What the verify cap did to one scan. `verifiedClaims` counts claims SENT to
 * verification; a verification that then failed at the provider is still
 * reported separately by ScanResult.verificationErrors.
 */
export interface VerificationSummary {
  /** The cap applied to this scan, after normalisation. */
  cap: number;
  /** Claims that met the bar for verification (fact of importance >= 2, or a citation claim). */
  eligibleClaims: number;
  /** Eligible claims sent to verification (min(cap, eligibleClaims)). */
  verifiedClaims: number;
  /** Eligible claims left unchecked because of the cap. */
  uncheckedClaims: number;
  /** Ids of the unchecked eligible claims, in ranking order. */
  uncheckedClaimIds: string[];
}

/**
 * Summarise the cap's effect from the ranked eligible claims and the subset
 * actually selected for verification.
 */
export function buildVerificationSummary(
  rankedEligible: Claim[],
  selected: Claim[],
  cap: number,
): VerificationSummary {
  // Object identity, not id: a model can return two claims with the same id.
  const selectedSet = new Set(selected);
  const unchecked = rankedEligible.filter((c) => !selectedSet.has(c));
  return {
    cap,
    eligibleClaims: rankedEligible.length,
    verifiedClaims: selected.length,
    uncheckedClaims: unchecked.length,
    uncheckedClaimIds: unchecked.map((c) => c.id),
  };
}
