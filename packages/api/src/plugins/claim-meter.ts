import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { ClaimReservation } from '../store/claim-meter.js';
import { billableClaims, committedClaim, ENGINE_VERIFY_CAP, recordScanId, reserveClaimsFor, type MeterRefusal } from '../lib/claim-meter.js';
import type { VerificationResult } from '@nxtg/faultline/types.js';
import { resolveVerifyPolicy } from './verify-cap.js';

/**
 * Claim-meter prehandlers, the per-key monthly CLAIM cap.
 *
 *   rateLimitScan        per-MINUTE burst throttle        → 429
 *   enforceMonthlyCap    per-KEY monthly scan quota       → 402 (dormant)
 *   enforceProviderSpend FLEET monthly USD at providers   → 503
 *   reserveClaims        per-KEY monthly claim cap        → 402 claim_cap_reached / claim_cap_unset
 *
 * `reserveClaims(max)` holds the most claims the route may verify BEFORE the
 * handler runs, so a refused request calls no provider. The handler commits the
 * claims that got a verdict (`commitClaims`) once the caller has them; the
 * server's onResponse hook releases whatever is still held, so every error path
 * frees its reservation. Streaming routes, which hijack the reply, release in
 * their own `finally` as well. With the meter off, or for an unmetered key,
 * nothing is reserved and nothing is committed.
 *
 * Must run AFTER requireApiKey (needs request.keyId) and after the other gates,
 * so a request they refuse never holds claims.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Claims this request holds against its key's cap. Unset for an unmetered key. */
    claimReservation?: ClaimReservation;
  }
}

/** How many claims a request may verify, read from the validated request. */
export type MaxClaims = (request: FastifyRequest) => number;

/** One scan at the request's plan cap (routes that pass `verifyCap` to the engine). */
export const planVerifyCap: MaxClaims = (request) =>
  resolveVerifyPolicy(request.keyId ?? 'unknown', request.headers['x-user-tier']).cap;

/** `scans` scans at the engine's own cap (routes that call scan() with no cap). */
export const engineVerifyCap = (scans = 1): MaxClaims => () => scans * ENGINE_VERIFY_CAP;

function refuse(reply: FastifyReply, refusal: MeterRefusal): void {
  reply.status(refusal.statusCode).send(refusal.body);
}

/** Prehandler: reserve `max(request)` claims for the request's key, or refuse. */
export function reserveClaims(max: MaxClaims): preHandlerAsyncHookHandler {
  return async function reserveClaimsHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const outcome = reserveClaimsFor(request.keyId, max(request));
    if (outcome.ok === false) {
      refuse(reply, outcome);
      return;
    }
    request.claimReservation = outcome.reservation;
  };
}

/**
 * Prehandler for routes that queue work to run later (jobs, schedules, the scan
 * queue, bulk uploads): refuse now when the key could not reserve one run,
 * holding nothing. The runner reserves for real when it runs.
 */
export function requireClaimHeadroom(max: MaxClaims): preHandlerAsyncHookHandler {
  return async function requireClaimHeadroomHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const outcome = reserveClaimsFor(request.keyId, max(request));
    if (outcome.ok === false) {
      refuse(reply, outcome);
      return;
    }
    outcome.reservation?.release();
  };
}

/** Commit the billable claims of a delivered scan result under the scan id the API issued. */
export function commitClaims(request: FastifyRequest, issuedScanId: string, result: unknown, provider: string): number {
  const reservation = request.claimReservation;
  if (!reservation) return 0;
  return reservation.commit(recordScanId(issuedScanId), billableClaims(result, provider));
}

/** Commit one streamed claim verdict as it is delivered. */
export function commitStreamedClaim(
  request: FastifyRequest,
  scanId: string,
  claimId: string,
  verdict: Partial<VerificationResult> | undefined,
  provider: string,
): void {
  const reservation = request.claimReservation;
  const claim = committedClaim(claimId, verdict, provider);
  if (reservation && claim) reservation.commit(scanId, [claim]);
}

/** Free whatever the request still holds. Safe to call more than once. */
export function releaseClaims(request: FastifyRequest): void {
  request.claimReservation?.release();
}
