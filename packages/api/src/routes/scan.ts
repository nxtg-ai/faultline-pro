import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getAnalyticsStore } from '../store/analytics.js';
import type { RiskLevel } from '../store/analytics.js';
import { fireWebhookEvent } from '../store/webhooks.js';
import { getCircuitBreaker } from '../store/circuit-breaker.js';
import type { Provider } from '../store/circuit-breaker.js';
import { getAuditLogger } from '../store/audit.js';
import { getScanCache } from '../store/cache.js';

const BODY_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 50000 },
    provider: {
      type: 'string',
      enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'],
    },
  },
  additionalProperties: false,
} as const;

interface ScanBody {
  text: string;
  provider?: 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';
}

export async function scanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ScanBody }>(
    '/scan',
    {
      preHandler: [requireApiKey, rateLimitScan],
      schema: { body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { text, provider } = request.body;

      const keyId = request.keyId ?? 'unknown';

      // Cache lookup — before failover / API calls
      const effectiveProvider = provider ?? 'gemini';
      const cached = getScanCache().get(text, effectiveProvider);
      if (cached) {
        reply.header('X-Cache', 'HIT');
        getAnalyticsStore().record(keyId, (cached as { overallRisk: string }).overallRisk as RiskLevel);
        fireWebhookEvent('scan.complete', cached);
        return reply.status(200).send(cached);
      }
      reply.header('X-Cache', 'MISS');

      const cb = getCircuitBreaker();
      const chain = cb.getChain(provider as Provider | undefined);

      if (chain.length === 0) {
        fireWebhookEvent('scan.failed', { error: 'All providers circuit-broken.' });
        return reply.status(503).send({ error: 'All providers are currently unavailable. Please retry later.' });
      }

      let lastError: string = '';
      const attempted: Provider[] = [];

      for (const p of chain) {
        try {
          const result = await scan(text, p);
          cb.recordSuccess(p);

          if (attempted.length > 0) {
            // Failover occurred — emit audit entry
            getAuditLogger().log({
              timestamp: new Date().toISOString(),
              keyId,
              endpoint: '/scan/failover',
              method: 'POST',
              statusCode: 200,
              latencyMs: 0,
              note: `Failover: ${attempted.join('->')} -> ${p}`,
            });
          }

          getScanCache().set(text, effectiveProvider, result as Record<string, unknown>);
          getAnalyticsStore().record(keyId, result.overallRisk as RiskLevel);
          fireWebhookEvent('scan.complete', result);
          return reply.status(200).send(result);
        } catch (err) {
          cb.recordFailure(p);
          attempted.push(p);
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      fireWebhookEvent('scan.failed', { error: lastError });
      return reply.status(500).send({ error: lastError });
    },
  );
}
