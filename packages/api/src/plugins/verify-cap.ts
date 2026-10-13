import { resolveVerifyCap, type VerificationSummary } from '@nxtg/faultline/cli/verify-cap.js';
import type { ManagedScanCostEvent } from '../store/costs.js';
import { resolveEntitledTier } from './consensus-entitlement.js';

type Tier = ManagedScanCostEvent['tier'];

/**
 * Claims verified per scan, by plan. Server-side only: no request field can set
 * or override it. Every plan is 8 today (node 1.18.11.3.5), so results and cost
 * per scan match the engine's fixed cap of 8 they replace. Each verified claim is
 * one grounded provider call, so raising a value raises that plan's cost per scan.
 */
export const VERIFY_CAP_BY_TIER: Readonly<Record<Tier, number>> = Object.freeze({
  enterprise: 8,
  pro: 8,
  personal: 8,
  free: 8,
  anon: 8,
  userkey: 8,
});

/** The cap for a plan; a missing or invalid table entry falls back to the engine default (8). */
export function verifyCapForTier(tier: Tier): number {
  return resolveVerifyCap(VERIFY_CAP_BY_TIER[tier]);
}

/** The plan a request is entitled to and the verify cap that plan carries. */
export interface VerifyPolicy {
  tier: Tier;
  cap: number;
}

/**
 * Resolve the verify policy for a request with the TRUSTED tier resolver:
 * x-user-tier is honoured only from the server's own key (resolveEntitledTier),
 * so a keystore key cannot buy a larger cap by sending the header.
 */
export function resolveVerifyPolicy(keyId: string, headerTier?: string | string[]): VerifyPolicy {
  const tier = resolveEntitledTier(keyId, headerTier);
  return { tier, cap: verifyCapForTier(tier) };
}

/** The engine's verification summary plus the plan whose cap produced it. */
export type TieredVerificationSummary = Partial<VerificationSummary> & { tier: Tier };

/**
 * Return a copy of a scan result whose `verification` summary names the plan.
 * Never mutates the input, so a cached result stays plan-neutral and each
 * response carries the tier of the request that receives it.
 */
export function withVerificationTier<T extends object>(
  result: T,
  tier: Tier,
): T & { verification: TieredVerificationSummary } {
  const existing = (result as { verification?: Partial<VerificationSummary> }).verification;
  return { ...result, verification: { ...existing, tier } };
}
