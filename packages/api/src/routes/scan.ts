import { randomUUID } from 'node:crypto';
import { apiEvidenceOptions, apiIndependentEvidenceOptions } from '../lib/evidence.js';
import { assertValidScanResult, isInvalidVerdictError } from '@nxtg/faultline/lib/verdict-guard.js';
import type { FastifyInstance } from 'fastify';
import { requireApiKey, resolveRequestTenantId } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { enforceMonthlyCap } from '../plugins/usage-cap.js';
import { enforceProviderSpendCap } from '../plugins/provider-spend-cap.js';
import { enforceConsensusEntitlement } from '../plugins/consensus-entitlement.js';
import { validateConsensusVoters, consensusHadNoVoters, consensusUnavailableBody, CONSENSUS_UNAVAILABLE_MESSAGE } from '../plugins/consensus-voters.js';
import { isConsensusUnavailableError } from '@nxtg/faultline/cli/verify-runner.js';
import { scanWithSpend } from '../lib/scan-spend.js';
import { meterScan, recordDeliveredScan } from '../lib/scan-quota.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import type { PipelineConfig } from '@nxtg/faultline/cli/scan.js';
import { getAnalyticsStore } from '../store/analytics.js';
import type { RiskLevel } from '../store/analytics.js';
import { fireWebhookEvent } from '../store/webhooks.js';
import { issueScanId } from '../lib/scan-access.js';
import { getCircuitBreaker } from '../store/circuit-breaker.js';
import type { Provider } from '../store/circuit-breaker.js';
import { getAuditLogger } from '../store/audit.js';
import { getScanCache } from '../store/cache.js';
import { cacheCaller, requestOwner } from '../lib/cache-caller.js';
import { ownsOrAdmin } from '../lib/ownership.js';
import { getTemplateStore } from '../store/templates.js';
import { getClaimIndex } from '../store/claims.js';
import { getCostStore } from '../store/costs.js';
import { getScanHistory, hashText } from '../store/scan-history.js';
import { recordScanTelemetry } from '../store/telemetry.js';
import { notifyScanFailed } from '../store/notifications.js';
import { buildEuComplianceReport, evaluateComplianceGate } from '@nxtg/faultline/cli/compliance-report.js';
import { resolveVerifyPolicy, withVerificationTier } from '../plugins/verify-cap.js';
import { isExtractionError, type ExtractionError } from '@nxtg/faultline/providers/extraction-error.js';
import { sendExtractionFailed } from '../lib/extraction-failure.js';
import { commitClaims, planVerifyCap, reserveClaims } from '../plugins/claim-meter.js';


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
        // Grounded multi-model consensus, the same fields POST /scan/stream takes.
        // Enterprise only: enforceConsensusEntitlement refuses the rest with a 403.
        // Listed here so the schema never strips them and serves a single-provider
        // scan to a caller who asked for consensus.
        consensus:            { type: 'boolean' },
        consensusProviders:   { type: 'array', uniqueItems: true, items: { type: 'string', enum: PROVIDER_ENUM } },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

type ScanProvider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

interface ScanBody {
  text: string;
  provider?: ScanProvider;
  pipelineConfig?: PipelineConfig;
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
      config: { access: 'owner' },
      preHandler: [requireApiKey, enforceConsensusEntitlement, validateConsensusVoters, rateLimitScan, enforceMonthlyCap, enforceProviderSpendCap, reserveClaims(planVerifyCap)],
      schema: { tags: ['Scan'], summary: 'Scan text for claim verification', body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { text, provider, pipelineConfig } = request.body;

      const keyId = request.keyId ?? 'unknown';
      const effectiveProvider = provider ?? 'gemini';
      // Server-side only: the cap comes from the entitled plan, never the body
      // (ScanOptions is not PipelineConfig, so no body field reaches it).
      const verifyPolicy = resolveVerifyPolicy(keyId, request.headers['x-user-tier']);
      const scanOptions = { verifyCap: verifyPolicy.cap, evidence: apiEvidenceOptions(), independentEvidence: apiIndependentEvidenceOptions() };

      // FR-3: pipelineConfig path — bypass cache and circuit breaker, use explicit providers
      if (pipelineConfig) {
        const startTime = Date.now();
        try {
          // Recorded in the provider-spend ledger like the other branch, also
          // when the scan throws after a provider call.
          const result = await scanWithSpend({ text, provider: effectiveProvider, pipelineConfig, keyId, startTime }, () => scan(
            text,
            effectiveProvider,
            /* minConfidence */ undefined,
            /* ruleNames */ undefined,
            /* onProgress */ undefined,
            /* onClaimVerified */ undefined,
            pipelineConfig,
            scanOptions,
          ));
          // A consensus run where no voter took part checked nothing: report failure,
          // with the reason when every failure shares one (an empty account, say).
          // A non-200 counts no scan of quota; the spend above is real and stays ledgered.
          if (pipelineConfig.consensus === true && consensusHadNoVoters(result)) {
            return reply.status(502).send(consensusUnavailableBody(result));
          }
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
          const delivered = issueScanId(enriched, request.keyId);
          commitClaims(request, delivered.scanId, result, effectiveProvider);
          recordDeliveredScan(request, delivered.verifications);
          fireWebhookEvent('scan.complete', delivered, requestOwner(request));
          return reply.status(200).send(delivered);
        } catch (err) {
          if (isConsensusUnavailableError(err)) {
            return reply.status(503).send({ error: 'consensus_unavailable', message: CONSENSUS_UNAVAILABLE_MESSAGE });
          }
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

      const caller = cacheCaller(request);
      const hit = caller === null ? null : getScanCache().get(caller, text, effectiveProvider, verifyPolicy.cap);
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
        const delivered = issueScanId(cachedEnriched, request.keyId);
        // A cached verdict delivered to the caller bills like a fresh one.
        commitClaims(request, delivered.scanId, cached, effectiveProvider);
        recordDeliveredScan(request, (delivered as { verifications?: unknown }).verifications);
        fireWebhookEvent('scan.complete', delivered, requestOwner(request));
        return reply.status(200).send(delivered);
      }
      reply.header('X-Cache', 'MISS');

      const cb = getCircuitBreaker();
      const chain = cb.getChain(provider as Provider | undefined);

      if (chain.length === 0) {
        fireWebhookEvent('scan.failed', { error: 'All providers circuit-broken.' }, requestOwner(request));
        return reply.status(503).send({ error: 'All providers are currently unavailable. Please retry later.' });
      }

      let lastError: string = '';
      let lastFailure: unknown;
      const attempted: Provider[] = [];
      const startTime = Date.now();

      for (const p of chain) {
        try {
          // Real measured usage composed across the fan-out, in the cost store, the
          // scan-cost log and the provider-spend ledger. A provider that fails after
          // spending is recorded too, before the loop fails over to the next one.
          const result = await scanWithSpend({ text, provider: p, keyId, startTime }, () => scan(
            text, p, undefined, undefined, undefined, undefined, undefined, scanOptions,
          ));
          cb.recordSuccess(p);
          getCostStore().record(keyId, p, text, resolveRequestTenantId(keyId));
          // A verdict outside the allowlist is refused before anything is stored
          // or cached (502 invalid_verdict; GoPMO 1.18.11.3 P2). The spend above is real.
          assertValidScanResult(result);

          // POST /scan is counted toward the monthly quota by the server's onResponse
          // hook, from the billable count recorded below; counting here as well would
          // count it twice. The template and stream routes count locally.

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

          if (caller !== null) getScanCache().set(caller, text, effectiveProvider, result as unknown as Record<string, unknown>, verifyPolicy.cap);
          const scanId = `scan-${randomUUID()}`;
          getClaimIndex().ingest(
            Array.isArray(result.claims) ? (result.claims as Array<{ id: string; text: string; type?: string }>) : [],
            (result.verifications ?? {}) as Record<string, { status?: string; sources?: Array<{ title: string; uri: string }> }>,
            scanId,
            caller,
            p,
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
          const delivered = issueScanId(enriched, request.keyId, scanId);
          commitClaims(request, delivered.scanId, result, p);
          recordDeliveredScan(request, delivered.verifications);
          fireWebhookEvent('scan.complete', delivered, requestOwner(request));
          return reply.status(200).send(delivered);
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
      fireWebhookEvent('scan.failed', { error: lastError }, requestOwner(request));
      void notifyScanFailed(keyId, lastError, attempted[attempted.length - 1] ?? effectiveProvider);
      if (extractionFailed) return sendExtractionFailed(reply, lastFailure as ExtractionError);
      return reply.status(500).send({ error: lastError });
    },
  );

  fastify.post<{ Params: { id: string }; Body: ScanTemplateBody }>(
    '/scan/template/:id',
    {
      config: { access: 'owner' },
      preHandler: [requireApiKey, rateLimitScan, enforceMonthlyCap, enforceProviderSpendCap, reserveClaims(planVerifyCap)],
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
      if (!template || !ownsOrAdmin(request, template.keyId)) {
        return reply.status(404).send({ error: 'Template not found.' });
      }

      const { text, provider } = request.body;
      const effectiveProvider = (provider ?? template.provider ?? 'openai') as ScanProvider;

      const keyId = request.keyId ?? 'unknown';
      const verifyPolicy = resolveVerifyPolicy(keyId, request.headers['x-user-tier']);
      const scanned = await scanWithSpend({ text, provider: effectiveProvider, keyId }, () => scan(
        text, effectiveProvider, undefined, undefined, undefined, undefined, undefined,
        { verifyCap: verifyPolicy.cap, evidence: apiEvidenceOptions(), independentEvidence: apiIndependentEvidenceOptions() },
      ));
      const result = withVerificationTier(scanned, verifyPolicy.tier);

      getAnalyticsStore().record(keyId, result.overallRisk as RiskLevel);
      meterScan(keyId, result.verifications);
      const delivered = issueScanId(result, request.keyId);
      commitClaims(request, delivered.scanId, result, effectiveProvider);
      fireWebhookEvent('scan.complete', delivered, requestOwner(request));

      return reply.status(200).send(delivered);
    },
  );
}
