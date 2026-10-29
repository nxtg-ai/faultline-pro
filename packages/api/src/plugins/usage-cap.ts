import type { FastifyRequest, FastifyReply } from 'fastify';
import { resolveTier } from './ratelimit.js';
import { getUsageMeter } from '../store/usage.js';
import { getMonthlyCap, isUsageCapEnabled } from '../store/entitlements.js';

/**
 * Monthly usage-cap prehandler — the margin-protecting gate (COGS gate, item 1).
 *
 * Distinct from `rateLimitScan`: that is a per-MINUTE burst throttle (abuse
 * protection); this is a per-MONTH scan quota tied to a tier's pricing (margin
 * protection). Both run; this one gates the paid-conversion economics.
 *
 * Semantics:
 *  - DORMANT by default (FAULTLINE_USAGE_CAP off) — no-op, so it is safe to deploy
 *    before the cap number / go-live is confirmed. Activation is Asif's pricing call.
 *  - A `null` cap for a tier (e.g. admin) is unlimited — no-op.
 *  - Otherwise: if the key's current-month scan count has reached the cap, respond
 *    402 Payment Required with an upgrade message; else set X-Usage-* headers and
 *    allow. A scan is counted only when its delivered result holds at least one
 *    billable verdict (lib/scan-quota.ts), so a scan that failed, or delivered
 *    only unverified or unsourced verdicts, never uses up a customer's quota.
 *
 * Must run AFTER requireApiKey (needs request.keyId).
 */

/** Unix seconds at the start of next calendar month (UTC) — when the quota resets. */
export function nextMonthResetEpoch(now: Date = new Date()): number {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return Math.floor(Date.UTC(year, month + 1, 1) / 1000);
}

/**
 * Every prehandler that runs the monthly-cap admission check. The route coverage
 * test reads it, so a route that runs a scan without one of these fails.
 */
const monthlyCapGates = new Set<unknown>();

export function markMonthlyCapGate<T>(gate: T): T {
  monthlyCapGates.add(gate);
  return gate;
}

export function isMonthlyCapGate(handler: unknown): boolean {
  return monthlyCapGates.has(handler);
}

/**
 * The admission check: refuse with 402 when `scans` more scans would take the key
 * past its monthly cap (used + scans > cap). Returns false when it refused.
 */
export function admitMonthlyScans(request: FastifyRequest, reply: FastifyReply, scans: number): boolean {
  if (!isUsageCapEnabled()) return true; // dormant — mechanism deployed, gate inactive

  const keyId = request.keyId ?? 'unknown';
  const tier = resolveTier(keyId);
  const cap = getMonthlyCap(tier);
  if (cap === null) return true; // unlimited tier

  const used = getUsageMeter().getMonthlyCount(keyId);
  const resetEpoch = nextMonthResetEpoch();
  const remaining = Math.max(0, cap - used);

  if (used + scans > cap) {
    reply
      .header('X-Usage-Limit', String(cap))
      .header('X-Usage-Remaining', String(remaining))
      .header('X-Usage-Reset', String(resetEpoch))
      .status(402)
      .send({
        error: 'Monthly scan quota exceeded.',
        tier,
        limit: cap,
        used,
        remaining,
        resetEpoch,
        upgrade: 'Upgrade your plan or wait for your monthly quota to reset. See https://faultline.nxtg.ai/pricing',
      });
    return false;
  }

  reply
    .header('X-Usage-Limit', String(cap))
    .header('X-Usage-Remaining', String(remaining))
    .header('X-Usage-Reset', String(resetEpoch));
  return true;
}

export const enforceMonthlyCap = markMonthlyCapGate(
  async function enforceMonthlyCap(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    admitMonthlyScans(request, reply, 1);
  },
);
