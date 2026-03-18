import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getAnalyticsStore } from '../store/analytics.js';
import type { RiskLevel } from '../store/analytics.js';
import { fireWebhookEvent } from '../store/webhooks.js';
import { getRateLimiter } from '../store/ratelimit.js';
import { getKeyStore } from '../store/keys.js';
import { getUsageMeter } from '../store/usage.js';
import type { Tier } from '../store/ratelimit.js';

type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

const BODY_SCHEMA = {
  type: 'object',
  required: ['texts'],
  properties: {
    texts: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'string', minLength: 1, maxLength: 50000 },
    },
    provider: {
      type: 'string',
      enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'],
    },
  },
  additionalProperties: false,
} as const;

interface BatchScanBody {
  texts: string[];
  provider?: Provider;
}

function resolveTier(keyId: string): Tier {
  if (keyId === 'admin') return 'admin';
  const key = getKeyStore().validateById(keyId);
  if (key && key.permissions.includes('admin')) return 'admin';
  if (key && key.permissions.includes('pro')) return 'pro';
  return 'free';
}

export async function batchRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: BatchScanBody }>(
    '/scan/batch',
    {
      preHandler: [requireApiKey],
      schema: { body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { texts, provider } = request.body;
      const keyId = request.keyId ?? 'unknown';
      const tier = resolveTier(keyId);
      const limiter = getRateLimiter();

      // Batch rate limit check: each text item counts as one scan.
      // Use getInfo() to read current remaining without side effects.
      const currentInfo = limiter.getInfo(keyId, tier);
      const { limit, remaining, resetEpoch } = currentInfo;

      if (remaining < texts.length) {
        // Not enough quota remaining for the whole batch
        reply
          .header('X-RateLimit-Limit', String(limit))
          .header('X-RateLimit-Remaining', '0')
          .header('X-RateLimit-Reset', String(resetEpoch))
          .status(429)
          .send({
            error: 'Rate limit exceeded.',
            limit,
            remaining: 0,
            resetEpoch,
          });
        return;
      }

      // Increment by texts.length
      for (let i = 0; i < texts.length; i++) {
        limiter.increment(keyId);
      }

      const afterInfo = limiter.getInfo(keyId, tier);
      reply
        .header('X-RateLimit-Limit', String(afterInfo.limit))
        .header('X-RateLimit-Remaining', String(afterInfo.remaining))
        .header('X-RateLimit-Reset', String(afterInfo.resetEpoch));

      // Process all texts concurrently
      const settled = await Promise.allSettled(
        texts.map((text) => scan(text, provider)),
      );

      type ScanResult = Awaited<ReturnType<typeof scan>>;
      const results: Array<ScanResult | null> = [];
      const errors: Array<{ index: number; error: string }> = [];

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
          const result = outcome.value;
          results.push(result);
          getAnalyticsStore().record(keyId, result.overallRisk as RiskLevel);
          getUsageMeter().increment(keyId);
          fireWebhookEvent('scan.complete', result);
        } else {
          results.push(null);
          const message =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
          errors.push({ index: i, error: message });
          fireWebhookEvent('scan.failed', { index: i, error: message });
        }
      }

      const succeeded = results.filter((r) => r !== null).length;
      const failed = errors.length;

      return reply.status(200).send({
        total: texts.length,
        succeeded,
        failed,
        results,
        errors,
      });
    },
  );
}
