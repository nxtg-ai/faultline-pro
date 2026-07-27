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
 *    allow. The count is incremented on a SUCCESSFUL scan (in the route), so failed
 *    scans never burn a user's quota.
 *
 * Must run AFTER requireApiKey (needs request.keyId).
 */

/** Unix seconds at the start of next calendar month (UTC) — when the quota resets. */
export function nextMonthResetEpoch(now: Date = new Date()): number {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return Math.floor(Date.UTC(year, month + 1, 1) / 1000);
}

export async function enforceMonthlyCap(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isUsageCapEnabled()) return; // dormant — mechanism deployed, gate inactive

  const keyId = request.keyId ?? 'unknown';
  const tier = resolveTier(keyId);
  const cap = getMonthlyCap(tier);
  if (cap === null) return; // unlimited tier

  const used = getUsageMeter().getMonthlyCount(keyId);
  const resetEpoch = nextMonthResetEpoch();

  if (used >= cap) {
    reply
      .header('X-Usage-Limit', String(cap))
      .header('X-Usage-Remaining', '0')
      .header('X-Usage-Reset', String(resetEpoch))
      .status(402)
      .send({
        error: 'Monthly scan quota exceeded.',
        tier,
        limit: cap,
        used,
        remaining: 0,
        resetEpoch,
        upgrade: 'Upgrade your plan or wait for your monthly quota to reset. See https://faultline.nxtg.ai/pricing',
      });
    return;
  }

  reply
    .header('X-Usage-Limit', String(cap))
    .header('X-Usage-Remaining', String(cap - used))
    .header('X-Usage-Reset', String(resetEpoch));
}
