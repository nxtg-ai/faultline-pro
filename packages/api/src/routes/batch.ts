import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { scanWithSpend } from '../lib/scan-spend.js';
import { isExtractionError } from '@nxtg/faultline/providers/extraction-error.js';
import { getAnalyticsStore } from '../store/analytics.js';
import type { RiskLevel } from '../store/analytics.js';
import { fireWebhookEvent } from '../store/webhooks.js';
import { issueScanId } from '../lib/scan-access.js';
import { requestOwner } from '../lib/cache-caller.js';
import { getRateLimiter } from '../store/ratelimit.js';
import { getKeyStore } from '../store/keys.js';
import { meterScan } from '../lib/scan-quota.js';
import type { Tier } from '../store/ratelimit.js';
import { getCircuitBreaker } from '../store/circuit-breaker.js';
import type { Provider } from '../store/circuit-breaker.js';

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

async function scanWithFailover(
  keyId: string,
  text: string,
  preferred: Provider | undefined,
): Promise<Awaited<ReturnType<typeof scan>>> {
  const cb = getCircuitBreaker();
  const chain = cb.getChain(preferred);
  if (chain.length === 0) throw new Error('All providers circuit-broken.');

  let lastError: unknown;
  for (const p of chain) {
    try {
      const result = await scanWithSpend({ text, provider: p, keyId }, () => scan(text, p));
      cb.recordSuccess(p);
      return result;
    } catch (err) {
      cb.recordFailure(p);
      lastError = err;
    }
  }
  // Keep an ExtractionError whole so its reason reaches the response.
  if (isExtractionError(lastError)) throw lastError;
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? '');
  throw new Error(message || 'All providers failed.');
}

export async function batchRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: BatchScanBody }>(
    '/scan/batch',
    {
      config: { access: 'key' },
      preHandler: [requireApiKey],
      schema: { tags: ['Scan'], summary: 'Batch scan multiple texts (1–10)', body: BODY_SCHEMA },
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

      // Process all texts concurrently with failover
      const settled = await Promise.allSettled(
        texts.map((text) => scanWithFailover(keyId, text, provider as Provider | undefined)),
      );

      type ScanResult = Awaited<ReturnType<typeof scan>>;
      const results: Array<ScanResult | null> = [];
      const errors: Array<{ index: number; error: string; reason?: string }> = [];

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
          const result = issueScanId(outcome.value, request.keyId);
          results.push(result);
          getAnalyticsStore().record(keyId, result.overallRisk as RiskLevel);
          meterScan(keyId, result.verifications);
          fireWebhookEvent('scan.complete', result, requestOwner(request));
        } else {
          results.push(null);
          const message =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
          // An extraction failure names itself; ExtractionError.message is customer-safe.
          errors.push(isExtractionError(outcome.reason)
            ? { index: i, error: message, reason: outcome.reason.reason }
            : { index: i, error: message });
          fireWebhookEvent('scan.failed', { index: i, error: message }, requestOwner(request));
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
