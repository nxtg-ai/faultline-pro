import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getUsageMeter } from '../store/usage.js';
import { resolveTier } from '../plugins/ratelimit.js';
import { getMonthlyCap, isUsageCapEnabled } from '../store/entitlements.js';
import { nextMonthResetEpoch } from '../plugins/usage-cap.js';
import { getProviderSpendLedger, getProviderSpendStatus } from '../store/provider-spend.js';
import { getGroundingAllowanceStatus } from '../store/grounding-allowance.js';

export async function usageRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/usage', { preHandler: requireApiKey, schema: { tags: ['Analytics'], summary: 'Per-key daily scan usage counts + monthly quota' } }, async (request, reply) => {
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

    return reply.status(200).send({
      keyId,
      usage: meter.getUsage(keyId),
      quota,
      ...(providerBudget ? { providerBudget } : {}),
      ...(groundingAllowance ? { groundingAllowance } : {}),
    });
  });
}
