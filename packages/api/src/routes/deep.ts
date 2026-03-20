import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getAnalyticsStore } from '../store/analytics.js';
import type { RiskLevel } from '../store/analytics.js';
import { fireWebhookEvent } from '../store/webhooks.js';
import { getCircuitBreaker } from '../store/circuit-breaker.js';
import type { Provider } from '../store/circuit-breaker.js';
import { getScanCache } from '../store/cache.js';
import { buildEvidenceLinks } from '../lib/url-validator.js';

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

interface DeepScanBody {
  text: string;
  provider?: Provider;
}

export async function deepRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: DeepScanBody }>(
    '/scan/deep',
    {
      preHandler: [requireApiKey, rateLimitScan],
      schema: { tags: ['Scan'], summary: 'Deep scan with URL evidence validation and scoring', body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { text, provider } = request.body;
      const keyId = request.keyId ?? 'unknown';
      const effectiveProvider = provider ?? 'gemini';

      // Check cache first
      const cached = getScanCache().get(text, `deep:${effectiveProvider}`);
      if (cached) {
        reply.header('X-Cache', 'HIT');
        getAnalyticsStore().record(keyId, (cached as { overallRisk: string }).overallRisk as RiskLevel);
        fireWebhookEvent('scan.complete', cached);
        return reply.status(200).send(cached);
      }
      reply.header('X-Cache', 'MISS');

      const cb = getCircuitBreaker();
      const chain = cb.getChain(provider);

      if (chain.length === 0) {
        fireWebhookEvent('scan.failed', { error: 'All providers circuit-broken.' });
        return reply.status(503).send({ error: 'All providers are currently unavailable.' });
      }

      let lastError = '';
      for (const p of chain) {
        try {
          const result = await scan(text, p);
          cb.recordSuccess(p);

          // Build evidence links from source URLs in verifications
          const claims = Array.isArray(result.claims) ? result.claims as Array<{ id: string; text: string }> : [];
          const verifications = (result.verifications ?? {}) as Record<string, { sources?: Array<{ title: string; uri: string }> }>;
          const evidenceLinks = await buildEvidenceLinks(claims, verifications);

          const enriched = { ...result, evidenceLinks };

          getScanCache().set(text, `deep:${effectiveProvider}`, enriched as unknown as Record<string, unknown>);
          getAnalyticsStore().record(keyId, result.overallRisk as RiskLevel);
          fireWebhookEvent('scan.complete', enriched);

          return reply.status(200).send(enriched);
        } catch (err) {
          cb.recordFailure(p);
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      fireWebhookEvent('scan.failed', { error: lastError });
      return reply.status(500).send({ error: lastError });
    },
  );
}
