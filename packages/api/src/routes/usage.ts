import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getUsageMeter } from '../store/usage.js';
import { resolveTier } from '../plugins/ratelimit.js';
import { getMonthlyCap, isUsageCapEnabled } from '../store/entitlements.js';
import { nextMonthResetEpoch } from '../plugins/usage-cap.js';
import { getProviderSpendLedger, getProviderSpendStatus } from '../store/provider-spend.js';
import { getGroundingAllowanceStatus } from '../store/grounding-allowance.js';
import { getFullScanJobStore } from '../store/full-scan-jobs.js';
import { claimCapFor, isMeteredKey } from '../lib/claim-meter.js';
import { getClaimMeter } from '../store/claim-meter.js';
import { getStripeMeterSink } from '../store/claim-meter-sync.js';
import { currentMonth } from '../store/provider-spend.js';
import { VERDICT_STATUSES } from '@nxtg/faultline/lib/verdict-guard.js';

/** Every verdict at 0, so the shape is the same before the first claim. */
function verdictCounts(byVerdict: Record<string, number>): Record<string, number> {
  return { ...Object.fromEntries(VERDICT_STATUSES.map((v) => [v, 0])), ...byVerdict };
}

/** A metered key's claim position this month (node 1.18.11.7.6). */
function claimsBlock(keyId: string) {
  const meter = getClaimMeter();
  const period = currentMonth();
  const cap = claimCapFor(keyId);
  const { used, byVerdict } = meter.usageFor(keyId, period);
  const reserved = meter.reservedFor(keyId);
  return { period, cap, used, reserved, remaining: Math.max(0, cap - used - reserved), byVerdict: verdictCounts(byVerdict) };
}

/** Fleet claim totals and how far Stripe sync is behind (admin only). */
function claimMeterBlock() {
  const meter = getClaimMeter();
  const totals = meter.totals();
  return { ...totals, byVerdict: verdictCounts(totals.byVerdict), sync: { ...getStripeMeterSink().getStatus(), ...meter.lag() } };
}

export async function usageRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/usage', { config: { access: 'owner' }, preHandler: requireApiKey, schema: { tags: ['Analytics'], summary: 'Per-key daily scan usage counts, monthly quota and claim meter' } }, async (request, reply) => {
    const keyId = request.keyId ?? 'unknown';
    const meter = getUsageMeter();

    // Monthly quota surface (item 1): the cap, this month's usage, and remaining.
    // `enforced` reflects whether the cap gate is live (dormant until go-live).
    const tier = resolveTier(keyId);
    const cap = getMonthlyCap(tier);
    const monthUsed = meter.getMonthlyCount(keyId);
    const quota = {
      tier,
      enforced: isUsageCapEnabled(),
      limit: cap, // null = unlimited
      used: monthUsed,
      remaining: cap === null ? null : Math.max(0, cap - monthUsed),
      resetEpoch: nextMonthResetEpoch(),
    };

    // Fleet provider-spend budget (A-110 item 1) — ADMIN ONLY. It is our COGS and
    // runway position, not the caller's quota; leaking it to every API key would
    // publish what Faultline spends. Customers see `quota`; operators see both.
    // `ledgerWriteFailures` > 0 means the ledger file is not being written and the
    // budget only lives in this process (N-230 instrument).
    const isAdmin = tier === 'admin';
    const providerBudget = isAdmin
      ? { ...getProviderSpendStatus(), ledgerWriteFailures: getProviderSpendLedger().getWriteFailures() }
      : undefined;
    // Daily Gemini grounded-prompt count vs Google's free allowance (N-230,
    // Asif ruling 2026-10-01). Admin only for the same reason as providerBudget.
    const groundingAllowance = isAdmin ? getGroundingAllowanceStatus() : undefined;
    // Full-scan refund rate over the trailing 7 days, from the terminal-job ledger
    // (emma-soul condition 4, GoPMO 1.18.11.3.12). `alert` = refunded units above
    // 10% of charged units; fp then reports the cause. Admin only: fleet-wide.
    const fullScanRefunds = isAdmin ? getFullScanJobStore().refundSummary() : undefined;
    // Claim meter: a metered key sees its own month; admin sees fleet totals and sync lag.
    const claims = isMeteredKey(request.keyId) ? claimsBlock(request.keyId) : undefined;
    const claimMeter = isAdmin ? claimMeterBlock() : undefined;

    return reply.status(200).send({
      keyId,
      usage: meter.getUsage(keyId),
      quota,
      ...(providerBudget ? { providerBudget } : {}),
      ...(groundingAllowance ? { groundingAllowance } : {}),
      ...(fullScanRefunds ? { fullScanRefunds } : {}),
      ...(claims ? { claims } : {}),
      ...(claimMeter ? { claimMeter } : {}),
    });
  });
}
