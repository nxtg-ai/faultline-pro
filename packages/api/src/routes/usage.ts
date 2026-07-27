import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getUsageMeter } from '../store/usage.js';
import { resolveTier } from '../plugins/ratelimit.js';
import { getMonthlyCap, isUsageCapEnabled } from '../store/entitlements.js';
import { nextMonthResetEpoch } from '../plugins/usage-cap.js';

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

    return reply.status(200).send({ keyId, usage: meter.getUsage(keyId), quota });
  });
}
