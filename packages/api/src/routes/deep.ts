import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { enforceProviderSpendCap } from '../plugins/provider-spend-cap.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { enforceMonthlyCap } from '../plugins/usage-cap.js';
import { meterScan } from '../lib/scan-quota.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { scanWithSpend } from '../lib/scan-spend.js';
import { getAnalyticsStore } from '../store/analytics.js';
import type { RiskLevel } from '../store/analytics.js';
import { fireWebhookEvent } from '../store/webhooks.js';
import { issueScanId } from '../lib/scan-access.js';
import { getCircuitBreaker } from '../store/circuit-breaker.js';
import type { Provider } from '../store/circuit-breaker.js';
import { getScanCache } from '../store/cache.js';
import { cacheCaller, requestOwner } from '../lib/cache-caller.js';
import { buildEvidenceLinks } from '../lib/url-validator.js';
import { commitClaims, engineVerifyCap, reserveClaims } from '../plugins/claim-meter.js';

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
      config: { access: 'key' },
      // Admission is not reserved: two requests admitted at the same time can both be served; the reservation build fixes that.
      preHandler: [requireApiKey, rateLimitScan, enforceMonthlyCap, enforceProviderSpendCap, reserveClaims(engineVerifyCap())],
      schema: { tags: ['Scan'], summary: 'Deep scan with URL evidence validation and scoring', body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { text, provider } = request.body;
      const keyId = request.keyId ?? 'unknown';
      const effectiveProvider = provider ?? 'gemini';

      // Check cache first
      const caller = cacheCaller(request);
      const hit = caller === null ? null : getScanCache().get(caller, text, `deep:${effectiveProvider}`);
      if (hit) {
        const cached: Record<string, unknown> = { ...hit.result, cache: { hit: true, checkedAt: hit.checkedAt } };
        reply.header('X-Cache', 'HIT');
        getAnalyticsStore().record(keyId, (cached as { overallRisk: string }).overallRisk as RiskLevel);
        const delivered = issueScanId(cached, request.keyId);
        // A cached verdict delivered to the caller bills like a fresh one.
        commitClaims(request, delivered.scanId, cached, effectiveProvider);
        // Counted like a /scan cache hit: once, when what it serves holds a billable verdict.
        meterScan(keyId, cached.verifications);
        fireWebhookEvent('scan.complete', delivered, requestOwner(request));
        return reply.status(200).send(delivered);
      }
      reply.header('X-Cache', 'MISS');

      const cb = getCircuitBreaker();
      const chain = cb.getChain(provider);

      if (chain.length === 0) {
        fireWebhookEvent('scan.failed', { error: 'All providers circuit-broken.' }, requestOwner(request));
        return reply.status(503).send({ error: 'All providers are currently unavailable.' });
      }

      let lastError = '';
      for (const p of chain) {
        try {
          const result = await scanWithSpend({ text, provider: p, keyId }, () => scan(text, p));
          cb.recordSuccess(p);

          // Build evidence links from source URLs in verifications
          const claims = Array.isArray(result.claims) ? result.claims as Array<{ id: string; text: string }> : [];
          const verifications = (result.verifications ?? {}) as Record<string, { sources?: Array<{ title: string; uri: string }> }>;
          const evidenceLinks = await buildEvidenceLinks(claims, verifications);

          const enriched = { ...result, evidenceLinks };

          if (caller !== null) getScanCache().set(caller, text, `deep:${effectiveProvider}`, enriched as unknown as Record<string, unknown>);
          getAnalyticsStore().record(keyId, result.overallRisk as RiskLevel);
          const delivered = issueScanId(enriched, request.keyId);
          commitClaims(request, delivered.scanId, result, p);
          meterScan(keyId, result.verifications);
          fireWebhookEvent('scan.complete', delivered, requestOwner(request));

          return reply.status(200).send(delivered);
        } catch (err) {
          cb.recordFailure(p);
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      fireWebhookEvent('scan.failed', { error: lastError }, requestOwner(request));
      return reply.status(500).send({ error: lastError });
    },
  );
}
