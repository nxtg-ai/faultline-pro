/**
 * Claim metering for a key (node 1.18.11.7.6): who is metered, what cap
 * applies, which claims of a scan bill, and a wrapper for work that runs
 * outside a request (scheduled jobs, schedules, the scan queue, bulk uploads).
 *
 * Metered keys are keystore keys without the `admin` permission. The server's
 * own key (keyId 'admin', which bills its own users) and admin keys are not
 * metered. A metered key's cap is its `claimCap`, else
 * FAULTLINE_DEFAULT_CLAIM_CAP, else 0: a key with no cap is refused.
 */
import { DEFAULT_VERIFY_CAP } from '@nxtg/faultline/cli/verify-cap.js';
import type { VerificationResult } from '@nxtg/faultline/types.js';
import { isAdminKeyId } from '../plugins/auth.js';
import { getKeyStore } from '../store/keys.js';
import {
  defaultClaimCap,
  getClaimMeter,
  isBillableVerdict,
  type ClaimCapRefusal,
  type ClaimReservation,
  type CommittedClaim,
} from '../store/claim-meter.js';

/** The most claims one scan verifies when a route passes no cap to the engine. */
export const ENGINE_VERIFY_CAP = DEFAULT_VERIFY_CAP;

/** The 402 body for a refused reservation. */
export interface ClaimCapReachedBody {
  error: 'claim_cap_reached';
  cap: number;
  used: number;
  remaining: number;
}

/** True when a request with this keyId is metered. */
export function isMeteredKey(keyId: string | undefined): keyId is string {
  return keyId !== undefined && keyId !== '' && !isAdminKeyId(keyId);
}

/** A metered key's monthly claim cap: its own, else the env default, else 0 (refused). */
export function claimCapFor(keyId: string): number {
  const own = getKeyStore().validateById(keyId)?.claimCap;
  if (typeof own === 'number' && Number.isInteger(own) && own >= 0) return own;
  return defaultClaimCap() ?? 0;
}

/**
 * Hold `claims` for `keyId`. Unmetered keys get `{ ok: true }` with no
 * reservation; a metered key over its cap gets the refusal.
 */
export function reserveClaimsFor(
  keyId: string | undefined,
  claims: number,
): { ok: true; reservation?: ClaimReservation } | ClaimCapRefusal {
  if (!isMeteredKey(keyId)) return { ok: true };
  return getClaimMeter().reserve(keyId, claims, claimCapFor(keyId));
}

export function claimCapReachedBody(refusal: ClaimCapRefusal): ClaimCapReachedBody {
  return { error: 'claim_cap_reached', cap: refusal.cap, used: refusal.used, remaining: refusal.remaining };
}

/** Thrown by `meteredScan` when the owner key cannot reserve; no provider was called. */
export class ClaimCapReachedError extends Error {
  readonly body: ClaimCapReachedBody;

  constructor(refusal: ClaimCapRefusal) {
    super('claim_cap_reached');
    this.name = 'ClaimCapReachedError';
    this.body = claimCapReachedBody(refusal);
  }
}

/** One verification as it can be committed: billable ones only. */
export function committedClaim(
  claimId: string,
  verification: Partial<VerificationResult> | undefined,
  fallbackProvider: string,
): CommittedClaim | null {
  if (!isBillableVerdict(verification)) return null;
  const provider = verification?.provenance?.provider ?? fallbackProvider;
  return { claimId, verdict: String(verification?.status), provider };
}

/** The billable claims of a scan result (`verifications` keyed by claim id). */
export function billableClaims(result: unknown, fallbackProvider: string): CommittedClaim[] {
  const verifications = (result as { verifications?: unknown } | null)?.verifications;
  if (!verifications || typeof verifications !== 'object') return [];
  const claims: CommittedClaim[] = [];
  for (const [claimId, verification] of Object.entries(verifications as Record<string, Partial<VerificationResult>>)) {
    const claim = committedClaim(claimId, verification, fallbackProvider);
    if (claim) claims.push(claim);
  }
  return claims;
}

/**
 * Run engine work for a key outside a request: reserve `maxClaims` first, run,
 * commit the verdicts of the result under `scanId`, release the rest. A key
 * over its cap throws ClaimCapReachedError before `run` is called. No keyId
 * (an object stored before owners were recorded) runs unmetered: there is no
 * customer to bill.
 */
export async function meteredScan<T>(
  keyId: string | undefined,
  maxClaims: number,
  scanId: string,
  provider: string,
  run: () => Promise<T>,
): Promise<T> {
  const outcome = reserveClaimsFor(keyId, maxClaims);
  if (outcome.ok === false) throw new ClaimCapReachedError(outcome);
  try {
    const result = await run();
    outcome.reservation?.commit(scanId, billableClaims(result, provider));
    return result;
  } finally {
    outcome.reservation?.release();
  }
}
