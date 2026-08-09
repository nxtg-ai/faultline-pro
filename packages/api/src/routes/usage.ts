import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getUsageMeter } from '../store/usage.js';
import { resolveTier } from '../plugins/ratelimit.js';
import { getMonthlyCap, isUsageCapEnabled } from '../store/entitlements.js';
import { nextMonthResetEpoch } from '../plugins/usage-cap.js';
import { getProviderSpendStatus } from '../store/provider-spend.js';

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
    const providerBudget = tier === 'admin' ? getProviderSpendStatus() : undefined;

    return reply.status(200).send({ keyId, usage: meter.getUsage(keyId), quota, ...(providerBudget ? { providerBudget } : {}) });
  });
}
