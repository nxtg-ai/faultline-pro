import { apiEvidenceOptions, apiIndependentEvidenceOptions } from '../lib/evidence.js';
import { assertValidScanResult, isInvalidVerdictError } from '@nxtg/faultline/lib/verdict-guard.js';
import type { FastifyInstance } from 'fastify';
import { requireApiKey, resolveRequestTenantId } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { enforceMonthlyCap } from '../plugins/usage-cap.js';
import { enforceProviderSpendCap } from '../plugins/provider-spend-cap.js';
import { recordProviderSpend } from '../store/provider-spend.js';
import { getUsageMeter } from '../store/usage.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getAnalyticsStore } from '../store/analytics.js';
import type { RiskLevel } from '../store/analytics.js';
import { fireWebhookEvent } from '../store/webhooks.js';
import { getCircuitBreaker } from '../store/circuit-breaker.js';
import type { Provider } from '../store/circuit-breaker.js';
import { getAuditLogger } from '../store/audit.js';
import { getScanCache } from '../store/cache.js';
import { cacheCaller } from '../lib/cache-caller.js';
import { getTemplateStore } from '../store/templates.js';
import { getClaimIndex } from '../store/claims.js';
import { getCostStore, emitScanCostEvent, appendScanCostLog, resolveTier, buildManagedCostEvent } from '../store/costs.js';
import { getScanHistory, hashText } from '../store/scan-history.js';
import { recordScanTelemetry } from '../store/telemetry.js';
import { notifyScanFailed } from '../store/notifications.js';
import { buildEuComplianceReport, evaluateComplianceGate } from '@nxtg/faultline/cli/compliance-report.js';
import { captureUsage } from '@nxtg/faultline/lib/usage-sink.js';
import { resolveVerifyPolicy, withVerificationTier } from '../plugins/verify-cap.js';
import { isExtractionError, type ExtractionError } from '@nxtg/faultline/providers/extraction-error.js';
import { sendExtractionFailed } from '../lib/extraction-failure.js';


const PROVIDER_ENUM = ['gemini', 'openai', 'claude', 'perplexity', 'mock'] as const;

const BODY_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 50000 },
    provider: {
      type: 'string',
      enum: PROVIDER_ENUM,
    },
    // FR-3: optional per-stage provider overrides
    pipelineConfig: {
      type: 'object',
      properties: {
        extractionProvider:   { type: 'string', enum: PROVIDER_ENUM },
        verificationProvider: { type: 'string', enum: PROVIDER_ENUM },
        synthesisProvider:    { type: 'string', enum: PROVIDER_ENUM },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

type ScanProvider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

interface PipelineConfigBody {
  extractionProvider?: ScanProvider;
  verificationProvider?: ScanProvider;
  synthesisProvider?: ScanProvider;
}

interface ScanBody {
  text: string;
  provider?: ScanProvider;
  pipelineConfig?: PipelineConfigBody;
}

const SCAN_TEMPLATE_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 50000 },
    provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
  },
  additionalProperties: false,
} as const;

interface ScanTemplateBody {
  text: string;
  provider?: ScanProvider;
}

/**
 * The first 200 characters of a failed extraction's provider error, for ops logs.
 * The provider's reply carries quota and status text, never the API key (sent in a
 * header) or the scanned text.
 */
function causeHead(err: Error): string {
  const cause = (err as { cause?: unknown }).cause;
  return (cause instanceof Error ? cause.message : String(cause ?? '')).slice(0, 200);
}

export async function scanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ScanBody }>(
    '/scan',
    {
      preHandler: [requireApiKey, rateLimitScan, enforceMonthlyCap, enforceProviderSpendCap],
      schema: { tags: ['Scan'], summary: 'Scan text for claim verification', body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { text, provider, pipelineConfig } = request.body;

      const keyId = request.keyId ?? 'unknown';
      const effectiveProvider = provider ?? 'gemini';
      // Server-side only: the cap comes from the entitled plan, never the body
      // (BODY_SCHEMA strips unknown fields, and ScanOptions is not PipelineConfig).
      const verifyPolicy = resolveVerifyPolicy(keyId, request.headers['x-user-tier']);
      const scanOptions = { verifyCap: verifyPolicy.cap, evidence: apiEvidenceOptions(), independentEvidence: apiIndependentEvidenceOptions() };

      // FR-3: pipelineConfig path — bypass cache and circuit breaker, use explicit providers
      if (pipelineConfig) {
        const startTime = Date.now();
        try {
          const result = await scan(
            text,
            effectiveProvider,
            /* minConfidence */ undefined,
            /* ruleNames */ undefined,
            /* onProgress */ undefined,
            /* onClaimVerified */ undefined,
            pipelineConfig,
            scanOptions,
          );
          getAnalyticsStore().record(keyId, result.overallRisk as RiskLevel);
          recordScanTelemetry({
            provider:    effectiveProvider,
            riskLevel:   result.overallRisk,
            claimCount:  Array.isArray(result.claims) ? result.claims.length : 0,
            claimTypes:  Array.isArray(result.claims)
              ? (result.claims as Array<{ type?: string }>).reduce<Record<string, number>>((acc, c) => {
                  const t = c.type ?? 'unknown'; acc[t] = (acc[t] ?? 0) + 1; return acc;
                }, {})
              : {},
            latencyMs:   Date.now() - startTime,
            inputLength: text.length,
            cacheHit:    false,
          });
          const compReport = buildEuComplianceReport(result, {});
          const compGate = evaluateComplianceGate(compReport);
          const enriched = withVerificationTier({
            ...result,
            complianceScore: compReport.complianceScore,
            compliancePass: compGate.pass,
          }, verifyPolicy.tier);
          fireWebhookEvent('scan.complete', enriched);
          return reply.status(200).send(enriched);
        } catch (err) {
          // Missing API key for a specified provider
          if (err instanceof Error && err.message.startsWith('No API key found for')) {
            const match = err.message.match(/"([^"]+)"/);
            const missing = match?.[1] ?? 'unknown';
            return reply.status(503).send({ error: 'provider_not_configured', provider: missing });
          }
          if (isExtractionError(err)) {
            console.error('/scan (pipelineConfig) extraction failed:', err.reason, causeHead(err));
            return sendExtractionFailed(reply, err);
          }
          return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
        }
      }

      const hit = getScanCache().get(cacheCaller(request), text, effectiveProvider, verifyPolicy.cap);
      const cached = hit?.result;
      if (hit && cached) {
        reply.header('X-Cache', 'HIT');
        getAnalyticsStore().record(keyId, (cached as { overallRisk: string }).overallRisk as RiskLevel);
        recordScanTelemetry({
          provider:    effectiveProvider,
          riskLevel:   (cached as { overallRisk: string }).overallRisk,
          claimCount:  Array.isArray((cached as { claims?: unknown[] }).claims) ? (cached as { claims: unknown[] }).claims.length : 0,
          claimTypes:  {},
          latencyMs:   0,
          inputLength: text.length,
          cacheHit:    true,
        });
        // Compute compliance for cached result too
        const cachedCompReport = buildEuComplianceReport(cached as unknown as Parameters<typeof buildEuComplianceReport>[0], {});
        const cachedCompGate = evaluateComplianceGate(cachedCompReport);
        const cachedEnriched = withVerificationTier({
          ...cached,
          complianceScore: cachedCompReport.complianceScore,
          compliancePass: cachedCompGate.pass,
          // Said in the result itself, so a cached verdict never reads as fresh.
          cache: { hit: true, checkedAt: hit.checkedAt },
        }, verifyPolicy.tier);
        fireWebhookEvent('scan.complete', cachedEnriched);
        return reply.status(200).send(cachedEnriched);
      }
      reply.header('X-Cache', 'MISS');

      const cb = getCircuitBreaker();
      const chain = cb.getChain(provider as Provider | undefined);

      if (chain.length === 0) {
        fireWebhookEvent('scan.failed', { error: 'All providers circuit-broken.' });
        return reply.status(503).send({ error: 'All providers are currently unavailable. Please retry later.' });
      }

      let lastError: string = '';
      let lastFailure: unknown;
      const attempted: Provider[] = [];
      const startTime = Date.now();

      for (const p of chain) {
        try {
          const { result, legs } = await captureUsage(() => scan(
            text, p, undefined, undefined, undefined, undefined, undefined, scanOptions,
          ));
          cb.recordSuccess(p);
          getCostStore().record(keyId, p, text, resolveRequestTenantId(keyId));

          // Managed-key scan cost telemetry (N-227 / DIRECTIVE-NXTG-20260506-04).
          // BLG-CLX9-20260703-005: real measured usage composed across the fan-out
          // (was a text-length estimate); legacy estimate is the no-legs fallback.
          const groundingCalls = typeof result.verifications === 'object' && result.verifications !== null
            ? Object.keys(result.verifications).length : 0;
          const costEvent = buildManagedCostEvent(legs, {
            text,
            provider: p,
            claimCount: groundingCalls,
            tier: resolveTier(keyId),
            latencyMs: Date.now() - startTime,
          });
          getCostStore().recordManaged(costEvent);
          emitScanCostEvent(costEvent);
          appendScanCostLog(costEvent);
          recordProviderSpend(costEvent); // A-110 item 1 — append-only provider-spend ledger
          // A verdict outside the allowlist is refused before anything is stored
          // or cached (502 invalid_verdict; GoPMO 1.18.11.3 P2). The spend above is real.
          assertValidScanResult(result);

          // NOTE: POST /scan usage is incremented by the server.ts onResponse hook
          // (isScanPost && 200) — do NOT increment here or it double-counts. The
          // stream + template routes below DO increment locally (the hook doesn't
          // cover /scan/stream or /scan/template).

          getScanHistory().record({
            textHash: hashText(text),
            textPreview: text.slice(0, 100),
            provider: p,
            overallRisk: (result as { overallRisk: string }).overallRisk,
            claimCount: Array.isArray((result as { claims?: unknown[] }).claims) ? (result as { claims: unknown[] }).claims.length : 0,
            latencyMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
            keyId,
            tenantId: resolveRequestTenantId(keyId),
          });

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

          getScanCache().set(cacheCaller(request), text, effectiveProvider, result as unknown as Record<string, unknown>, verifyPolicy.cap);
          const scanId = `scan-${Date.now()}`;
          getClaimIndex().ingest(
            Array.isArray(result.claims) ? (result.claims as Array<{ id: string; text: string; type?: string }>) : [],
            (result.verifications ?? {}) as Record<string, { status?: string; sources?: Array<{ title: string; uri: string }> }>,
            scanId,
          );
          getAnalyticsStore().record(keyId, result.overallRisk as RiskLevel);
          recordScanTelemetry({
            provider:    p,
            riskLevel:   result.overallRisk,
            claimCount:  Array.isArray(result.claims) ? result.claims.length : 0,
            claimTypes:  Array.isArray(result.claims)
              ? (result.claims as Array<{ type?: string }>).reduce<Record<string, number>>((acc, c) => {
                  const t = c.type ?? 'unknown'; acc[t] = (acc[t] ?? 0) + 1; return acc;
                }, {})
              : {},
            latencyMs:   Date.now() - startTime,
            inputLength: text.length,
            cacheHit:    false,
          });
          // Inline compliance score — EU AI Act readiness without separate API call
          const compReport = buildEuComplianceReport(result, {});
          const compGate = evaluateComplianceGate(compReport);
          const enriched = withVerificationTier({
            ...result,
            complianceScore: compReport.complianceScore,
            compliancePass: compGate.pass,
          }, verifyPolicy.tier);
          fireWebhookEvent('scan.complete', enriched);
          return reply.status(200).send(enriched);
        } catch (err) {
          if (isInvalidVerdictError(err)) throw err;
          cb.recordFailure(p);
          attempted.push(p);
          lastFailure = err;
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      // Every provider in the chain failed. When the last one failed at extraction,
      // say so (502 extraction_failed + reason), never with the provider's own text.
      const extractionFailed = isExtractionError(lastFailure);
      if (isExtractionError(lastFailure)) {
        console.error('/scan extraction failed on the last provider tried:', lastFailure.reason, causeHead(lastFailure));
      }

      recordScanTelemetry({
        provider:    attempted[attempted.length - 1] ?? effectiveProvider,
        riskLevel:   'unknown',
        claimCount:  0,
        claimTypes:  {},
        latencyMs:   Date.now() - startTime,
        inputLength: text.length,
        cacheHit:    false,
        errorCode:   extractionFailed ? 502 : 500,
      });
      fireWebhookEvent('scan.failed', { error: lastError });
      void notifyScanFailed(keyId, lastError, attempted[attempted.length - 1] ?? effectiveProvider);
      if (extractionFailed) return sendExtractionFailed(reply, lastFailure as ExtractionError);
      return reply.status(500).send({ error: lastError });
    },
  );

  fastify.post<{ Params: { id: string }; Body: ScanTemplateBody }>(
    '/scan/template/:id',
    {
      preHandler: [requireApiKey, rateLimitScan, enforceMonthlyCap, enforceProviderSpendCap],
      schema: {
        tags: ['Scan'],
        summary: 'Scan text using a saved template',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: SCAN_TEMPLATE_SCHEMA,
      },
    },
    async (request, reply) => {
      const template = getTemplateStore().get(request.params.id);
      if (!template) {
        return reply.status(404).send({ error: 'Template not found.' });
      }

      const { text, provider } = request.body;
      const effectiveProvider = (provider ?? template.provider ?? 'openai') as ScanProvider;

      const keyId = request.keyId ?? 'unknown';
      const verifyPolicy = resolveVerifyPolicy(keyId, request.headers['x-user-tier']);
      const scanned = await scan(
        text, effectiveProvider, undefined, undefined, undefined, undefined, undefined,
        { verifyCap: verifyPolicy.cap, evidence: apiEvidenceOptions(), independentEvidence: apiIndependentEvidenceOptions() },
      );
      const result = withVerificationTier(scanned, verifyPolicy.tier);

      getAnalyticsStore().record(keyId, result.overallRisk as RiskLevel);
      getUsageMeter().increment(keyId); // count toward monthly cap (item 1)
      fireWebhookEvent('scan.complete', result);

      return reply.status(200).send(result);
    },
  );
}
