/**
 * Full scan ("deep scan" in product copy), the pure half: which claims a full
 * scan checks, how many units it costs, and what it reports.
 *
 * A quick scan verifies at most the per-tier cap of ranked facts. A full scan
 * verifies EVERY claim of type `fact`, any importance, in extraction order, and
 * reports opinions and interpretations as not checkable. Charging is per unit
 * of CLAIMS_PER_UNIT fact claims, fixed at the estimate; units the provider did
 * not serve are refunded.
 *
 * Spec: docs/design/2026-10-13-full-scan-api.md §2 and §4 (GoPMO 1.18.11.3.12).
 */
import type { Claim, VerificationResult } from '../types.js';
import type { VerificationSummary } from './verify-cap.js';
import { isBillableVerdict } from '../lib/verdict-guard.js';

/** Fact claims per charged unit (ruling 1.18.11.3.8: the quick scan's K = 8). */
export const CLAIMS_PER_UNIT = 8;

/** A scan's verify scope. `quick` is the capped, ranked default. */
export type ScanMode = 'quick' | 'full';

/** Claims of a full scan split by whether they can be checked. */
export interface FullScanPartition {
  /** Claims of type `fact`, extraction order. These are verified. */
  facts: Claim[];
  /** Opinions and interpretations, extraction order. Never verified. */
  notCheckable: Claim[];
}

/**
 * The verification summary of a full scan. It extends the quick summary so a
 * consumer reading only the quick fields still gets true numbers:
 *
 * - `cap`: the number of fact claims. A full scan has no cap; every fact is in scope.
 * - `eligibleClaims`: the number of fact claims (every fact is eligible, any importance).
 * - `verifiedClaims`: fact claims sent to verification (started).
 * - `uncheckedClaims` / `uncheckedClaimIds`: fact claims never started because
 *   the run was stopped. 0 / [] for a run that completed.
 */
export interface FullVerificationSummary extends VerificationSummary {
  mode: 'full';
  /** Claims of type `fact`. */
  factClaims: number;
  /** Ids of opinion and interpretation claims, extraction order. */
  notCheckableClaimIds: string[];
  /** Fact claims with a billable verdict (isBillableVerdict: supported, contradicted or mixed, with a source, no apiError). */
  servedClaims: number;
  /** Ids of fact claims started that ended without a billable verdict (an apiError, `unverified`, or no source). */
  unservedClaimIds: string[];
}

/** Unit accounting for one full scan. */
export interface UnitAccounting {
  /** Units charged at the estimate. */
  charged: number;
  /** Units the served claims are worth: ceil(servedClaims / CLAIMS_PER_UNIT). */
  served: number;
  /** Units to give back: max(0, charged - served). */
  refund: number;
}

/**
 * Split claims into facts (verified) and the rest (not checkable).
 *
 * @example
 *   partitionForFullScan([{ type: 'fact', ... }, { type: 'opinion', ... }])
 *   // { facts: [the fact], notCheckable: [the opinion] }
 */
export function partitionForFullScan(claims: Claim[]): FullScanPartition {
  return {
    facts: claims.filter((c) => c.type === 'fact'),
    notCheckable: claims.filter((c) => c.type !== 'fact'),
  };
}

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Units a full scan of `factClaims` fact claims costs.
 *
 * @example
 *   unitsForFullScan(31) // 4
 *   unitsForFullScan(8)  // 1
 *   unitsForFullScan(0)  // 0
 */
export function unitsForFullScan(factClaims: number): number {
  return Math.ceil(nonNegativeCount(factClaims) / CLAIMS_PER_UNIT);
}

/**
 * What a full scan served against what it charged.
 *
 * @example
 *   unitAccounting(4, 29) // { charged: 4, served: 4, refund: 0 }
 *   unitAccounting(4, 20) // { charged: 4, served: 3, refund: 1 }
 *   unitAccounting(4, 0)  // { charged: 4, served: 0, refund: 4 }
 */
export function unitAccounting(chargedUnits: number, servedClaims: number): UnitAccounting {
  const charged = nonNegativeCount(chargedUnits);
  const served = Math.ceil(nonNegativeCount(servedClaims) / CLAIMS_PER_UNIT);
  return { charged, served, refund: Math.max(0, charged - served) };
}

/** True when a started claim got a billable verdict, the same rule every billed count uses. */
function isServed(result: VerificationResult | undefined): boolean {
  return result !== undefined && isBillableVerdict(result);
}

/**
 * Build the full-scan summary from the partition and the verify run.
 *
 * @param partition    facts and not-checkable claims of the scan
 * @param results      verdict per fact, aligned with `partition.facts`; undefined = never started
 */
export function buildFullVerificationSummary(
  partition: FullScanPartition,
  results: Array<VerificationResult | undefined>,
): FullVerificationSummary {
  const { facts, notCheckable } = partition;
  const started = facts.filter((_, i) => results[i] !== undefined);
  const notStarted = facts.filter((_, i) => results[i] === undefined);
  const unserved = facts.filter((_, i) => results[i] !== undefined && !isServed(results[i]));
  return {
    mode: 'full',
    cap: facts.length,
    eligibleClaims: facts.length,
    verifiedClaims: started.length,
    uncheckedClaims: notStarted.length,
    uncheckedClaimIds: notStarted.map((c) => c.id),
    factClaims: facts.length,
    notCheckableClaimIds: notCheckable.map((c) => c.id),
    servedClaims: facts.filter((_, i) => isServed(results[i])).length,
    unservedClaimIds: unserved.map((c) => c.id),
  };
}
