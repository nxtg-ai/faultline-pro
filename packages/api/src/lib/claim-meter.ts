/**
 * Claim metering for a key: who is metered, what cap applies, which claims of
 * a scan bill, and a wrapper for work that runs outside a request (scheduled
 * jobs, schedules, the scan queue, bulk uploads).
 *
 * Nothing is metered unless FAULTLINE_CLAIM_METER is on. Then only keys with
 * `metered: true` are metered. The server's own key (keyId 'admin'), the
 * measurement key (FAULTLINE_MEASUREMENT_KEY, keyId 'measurement'), admin keys
 * and every key without `metered: true` run exactly as they do with the meter
 * off. A metered key with no `claimCap` is refused (402 claim_cap_unset): the
 * meter fails closed. A metered key that was disabled, expired or deleted gets
 * no new reservation (403 key_revoked); rows it already committed stay.
 */
import { DEFAULT_VERIFY_CAP } from '@nxtg/faultline/cli/verify-cap.js';
import { isBillableVerdict } from '@nxtg/faultline/lib/verdict-guard.js';
import type { VerificationResult } from '@nxtg/faultline/types.js';
import { getKeyStore, type ApiKey } from '../store/keys.js';
import { MEASUREMENT_KEY_ID } from '../plugins/auth.js';
import {
  getClaimMeter,
  isClaimMeterEnabled,
  type ClaimCapRefusal,
  type ClaimReservation,
  type CommittedClaim,
} from '../store/claim-meter.js';

/** The most claims one scan verifies when a route passes no cap to the engine. */
export const ENGINE_VERIFY_CAP = DEFAULT_VERIFY_CAP;

/** The 402 body when the cap cannot cover a request. */
export interface ClaimCapReachedBody {
  error: 'claim_cap_reached';
  cap: number;
  used: number;
  remaining: number;
  period: string;
  resetsAt: string;
}

/** Every refusal the meter answers, with its status code. */
export type MeterRefusal =
  | { ok: false; statusCode: 402; body: ClaimCapReachedBody }
  | { ok: false; statusCode: 402; body: { error: 'claim_cap_unset' } }
  | { ok: false; statusCode: 403; body: { error: 'key_revoked' } };

export type MeterOutcome = { ok: true; reservation?: ClaimReservation } | MeterRefusal;

const CAP_UNSET: MeterRefusal = { ok: false, statusCode: 402, body: { error: 'claim_cap_unset' } };
const KEY_REVOKED: MeterRefusal = { ok: false, statusCode: 403, body: { error: 'key_revoked' } };

type MeterCheck =
  | { kind: 'unmetered' }
  | { kind: 'metered'; key: ApiKey & { claimCap: number } }
  | { kind: 'refused'; refusal: MeterRefusal };

const UNMETERED: MeterCheck = { kind: 'unmetered' };
const REVOKED_CHECK: MeterCheck = { kind: 'refused', refusal: KEY_REVOKED };
const CAP_UNSET_CHECK: MeterCheck = { kind: 'refused', refusal: CAP_UNSET };

/**
 * Identities that are never metered, whatever the keystore holds: no owner
 * (work stored before owners were recorded), the server's own key and the
 * measurement key. None of them is a customer, so there is nobody to bill.
 */
function isNeverMetered(keyId: string | undefined): boolean {
  return keyId === undefined || keyId === '' || keyId === 'admin' || keyId === MEASUREMENT_KEY_ID;
}

const isRevoked = (key: ApiKey, now: Date): boolean =>
  key.disabled === true || (key.expiresAt !== undefined && new Date(key.expiresAt) <= now);

/** Decide whether `keyId`'s work is metered, and refuse it when it may not run. */
export function meterCheck(keyId: string | undefined, now: Date = new Date()): MeterCheck {
  if (!isClaimMeterEnabled()) return UNMETERED;
  if (isNeverMetered(keyId)) return UNMETERED;
  const store = getKeyStore();
  const key = store.validateById(keyId);
  if (!key) return store.wasRevokedMetered(keyId) ? REVOKED_CHECK : UNMETERED;
  if (key.metered !== true || key.permissions.includes('admin')) return UNMETERED;
  if (isRevoked(key, now)) return REVOKED_CHECK;
  const cap = key.claimCap;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0) return CAP_UNSET_CHECK;
  return { kind: 'metered', key: key as ApiKey & { claimCap: number } };
}

/** True when `keyId`'s claims are counted right now. */
export function isMeteredKey(keyId: string | undefined): keyId is string {
  if (!isClaimMeterEnabled() || isNeverMetered(keyId)) return false;
  const key = getKeyStore().validateById(keyId);
  return key?.metered === true && !key.permissions.includes('admin');
}

/** The key's Stripe customer as it is now (read at commit time). */
const customerOf = (keyId: string) => (): string | null => getKeyStore().validateById(keyId)?.stripeCustomerId ?? null;

export function claimCapReachedBody(refusal: ClaimCapRefusal): ClaimCapReachedBody {
  return {
    error: 'claim_cap_reached',
    cap: refusal.cap,
    used: refusal.used,
    remaining: refusal.remaining,
    period: refusal.period,
    resetsAt: refusal.resetsAt,
  };
}

/**
 * Hold `claims` for `keyId`. An unmetered key gets `{ ok: true }` with no
 * reservation; a metered key over its cap, without a cap, or revoked gets the
 * refusal and nothing is held.
 */
export function reserveClaimsFor(keyId: string | undefined, claims: number, now: Date = new Date()): MeterOutcome {
  const check = meterCheck(keyId, now);
  if (check.kind === 'unmetered') return { ok: true };
  if (check.kind === 'refused') return check.refusal;
  const outcome = getClaimMeter().reserve(check.key.id, claims, check.key.claimCap, customerOf(check.key.id), now);
  if (outcome.ok === false) return { ok: false, statusCode: 402, body: claimCapReachedBody(outcome) };
  return outcome;
}

/** Thrown by `meteredScan` when the owner key may not reserve; no provider was called. */
export class ClaimMeterRefusedError extends Error {
  readonly statusCode: number;
  readonly body: MeterRefusal['body'];

  constructor(refusal: MeterRefusal) {
    super(refusal.body.error);
    this.name = 'ClaimMeterRefusedError';
    this.statusCode = refusal.statusCode;
    this.body = refusal.body;
  }
}

/** One verification as it can be committed: billable ones only (the engine's rule). */
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The usage-record scanId for a scan id the API issued. Scans are issued as
 * `scan-<uuid>`; the record carries the bare UUID so `scanId:claimId` stays
 * within 95 characters. Anything else passes through unchanged (and a non-UUID
 * is refused at commit).
 */
export function recordScanId(issued: string): string {
  const bare = issued.startsWith('scan-') ? issued.slice(5) : issued;
  return UUID_PATTERN.test(bare) ? bare : issued;
}

/**
 * The usage-record scanId of a full-scan job. Job ids are
 * `fsj_<base36 time>_<32 hex>`, and the 32 hex are a UUID with its dashes
 * removed, so the UUID is rebuilt from the id: the void path can find a job's
 * rows from its id alone after a restart.
 */
export function jobRecordScanId(jobId: string): string {
  const hex = /_([0-9a-f]{32})$/.exec(jobId)?.[1];
  if (!hex) return jobId;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Run engine work for a key outside a request: reserve `maxClaims` first, run,
 * commit the verdicts of the result under `scanId`, release the rest. A key
 * that may not reserve throws ClaimMeterRefusedError before `run` is called.
 */
export async function meteredScan<T>(
  keyId: string | undefined,
  maxClaims: number,
  scanId: string,
  provider: string,
  run: () => Promise<T>,
): Promise<T> {
  const outcome = reserveClaimsFor(keyId, maxClaims);
  if (outcome.ok === false) throw new ClaimMeterRefusedError(outcome);
  try {
    const result = await run();
    outcome.reservation?.commit(scanId, billableClaims(result, provider));
    return result;
  } finally {
    outcome.reservation?.release();
  }
}
