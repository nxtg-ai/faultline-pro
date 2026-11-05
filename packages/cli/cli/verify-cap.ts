import type { Claim } from '../types.js';

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

/** A claim is worth verifying when it is a fact of importance 2 or higher. */
export function isEligibleForVerification(claim: Claim): boolean {
  return claim.type === 'fact' && claim.importance >= 2;
}

/** Eligible claims, most important first (stable sort keeps extraction order on ties). */
export function rankEligibleClaims(claims: Claim[]): Claim[] {
  return claims
    .filter(isEligibleForVerification)
    .sort((a, b) => b.importance - a.importance);
}

/**
 * What the verify cap did to one scan. `verifiedClaims` counts claims SENT to
 * verification; a verification that then failed at the provider is still
 * reported separately by ScanResult.verificationErrors.
 */
export interface VerificationSummary {
  /** The cap applied to this scan, after normalisation. */
  cap: number;
  /** Claims that met the bar for verification (fact, importance >= 2). */
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
