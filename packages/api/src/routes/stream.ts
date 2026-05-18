import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import type { PipelineConfig } from '@nxtg/faultline/cli/scan.js';
import { randomUUID } from 'node:crypto';
import { getCostStore, computeScanCost, emitScanCostEvent, appendScanCostLog, resolveTierFromRequest, PROVIDER_MODEL_IDS, type ManagedScanCostEvent } from '../store/costs.js';

type ScanProvider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

const VALID_PROVIDERS = new Set<ScanProvider>(['gemini', 'openai', 'claude', 'perplexity', 'mock']);
const PROVIDER_ENUM = ['gemini', 'openai', 'claude', 'perplexity', 'mock'] as const;

const POST_STREAM_BODY_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 50000 },
    provider: { type: 'string', enum: PROVIDER_ENUM },
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

interface StreamPostBody {
  text: string;
  provider?: ScanProvider;
  pipelineConfig?: PipelineConfig;
}

/**
 * N-134/N-135 — Server-Sent Events scan streaming with progressive per-claim delivery.
 * GET /scan/stream?text=...&provider=mock
 *
 * Uses scan()'s onClaimVerified callback (N-135) to emit claim_verified events
 * as each claim is verified, rather than buffering until scan completes.
 *
 * Event sequence:
 *   data: {"type":"start","claimCount":N,"provider":"mock"}        ← on first claim verified
 *   data: {"type":"claim_verified","index":0,"claim":{...},"verdict":{...}}  × N
 *   data: {"type":"complete","overallRisk":"low","claimCount":N}
 *   data: {"type":"error","message":"..."}  (on failure only)
 */
export async function streamRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { text?: string; provider?: string } }>(
    '/scan/stream',
    {
      preHandler: [requireApiKey, rateLimitScan],
      schema: {
        tags: ['Scan'],
        summary: 'Stream scan results via Server-Sent Events (progressive per-claim delivery)',
        description: 'Runs a scan and streams progress events (start → claim_verified × N → complete) in SSE format. claim_verified events are emitted progressively as each claim is verified.',
        querystring: {
          type: 'object',
          properties: {
            text:     { type: 'string', minLength: 1, maxLength: 50000, description: 'Text to scan' },
            provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'], description: 'Provider (default: openai)' },
          },
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const { text, provider } = request.query;

      if (!text) {
        return reply.status(400).send({ error: 'Missing required query param: text' });
      }

      const effectiveProvider: ScanProvider = VALID_PROVIDERS.has(provider as ScanProvider)
        ? (provider as ScanProvider)
        : 'openai';

      const chunks: string[] = [];
      const emit = (data: Record<string, unknown>): void => {
        chunks.push(`data: ${JSON.stringify(data)}\n\n`);
      };

      let startEmitted = false;
      const keyId = (request as unknown as { keyId?: string }).keyId ?? 'unknown';
      const startTime = Date.now();

      try {
        const result = await scan(
          text,
          effectiveProvider,
          undefined,
          undefined,
          undefined,
          (claim, verdict, index, total) => {
            // Emit start on first claim — claimCount known from total param
            if (!startEmitted) {
              emit({ type: 'start', claimCount: total, provider: effectiveProvider });
              startEmitted = true;
            }
            emit({
              type: 'claim_verified',
              index,
              claim: claim as unknown as Record<string, unknown>,
              verdict: verdict as unknown as Record<string, unknown>,
            });
          },
        );

        const claimCount = Array.isArray(result.claims) ? result.claims.length : 0;

        // Fallback: emit start if no claims were verified (0-claim edge case)
        if (!startEmitted) {
          emit({ type: 'start', claimCount, provider: effectiveProvider });
        }

        emit({ type: 'complete', overallRisk: result.overallRisk, claimCount });

        // DIRECTIVE-NXTG-20260518-02: managed-inference cost telemetry for /scan/stream.
        // Fire-and-forget — must not block the SSE response.
        const inputTokens = Math.ceil(text.length / 4);
        const outputTokens = Math.ceil(inputTokens * 0.3);
        const groundingCalls = claimCount;
        const costUsd = computeScanCost(inputTokens, outputTokens, groundingCalls, effectiveProvider);
        const costEvent: ManagedScanCostEvent = {
          scanId: randomUUID(),
          ts: new Date().toISOString(),
          tier: resolveTierFromRequest(keyId, request.headers['x-user-tier']),
          keyMode: 'managed',
          provider: effectiveProvider,
          modelId: PROVIDER_MODEL_IDS[effectiveProvider] ?? effectiveProvider,
          inputTokens,
          outputTokens,
          groundingCalls,
          costUsd,
          latencyMs: Date.now() - startTime,
          cacheHit: false,
        };
        getCostStore().recordManaged(costEvent);
        emitScanCostEvent(costEvent);
        appendScanCostLog(costEvent);
      } catch (err) {
        if (!startEmitted) {
          emit({ type: 'start', claimCount: 0, provider: effectiveProvider });
        }
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }

      reply
        .header('Content-Type', 'text/event-stream')
        .header('Cache-Control', 'no-cache')
        .header('Connection', 'keep-alive')
        .send(chunks.join(''));
    },
  );

  /**
   * FR-1 — POST /scan/stream
   *
   * Same SSE event sequence as GET /scan/stream but accepts a JSON body,
   * removing the ~2KB querystring ceiling. Also supports FR-3 pipelineConfig.
   *
   * Event sequence:
   *   data: {"type":"start","claimCount":N,"provider":"..."}
   *   data: {"type":"claim_verified","index":N,"claim":{...},"verdict":{...}}  × N
   *   data: {"type":"complete","overallRisk":"low|medium|high|critical","claimCount":N}
   *   data: {"type":"error","message":"..."}  (on failure only)
   */
  fastify.post<{ Body: StreamPostBody }>(
    '/scan/stream',
    {
      preHandler: [requireApiKey, rateLimitScan],
      schema: {
        tags: ['Scan'],
        summary: 'Stream scan results via SSE (POST — no URL length ceiling)',
        description: 'Identical SSE event sequence to GET /scan/stream but accepts a JSON body, removing the ~2KB querystring ceiling. Supports pipelineConfig for per-stage provider routing (FR-3).',
        body: POST_STREAM_BODY_SCHEMA,
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const { text, provider, pipelineConfig } = request.body;

      const effectiveProvider: ScanProvider = VALID_PROVIDERS.has(provider as ScanProvider)
        ? (provider as ScanProvider)
        : 'openai';

      const chunks: string[] = [];
      const emit = (data: Record<string, unknown>): void => {
        chunks.push(`data: ${JSON.stringify(data)}\n\n`);
      };

      let startEmitted = false;
      const keyId = (request as unknown as { keyId?: string }).keyId ?? 'unknown';
      const startTime = Date.now();

      try {
        const result = await scan(
          text,
          effectiveProvider,
          /* minConfidence */ undefined,
          /* ruleNames */ undefined,
          /* onProgress */ undefined,
          (claim, verdict, index, total) => {
            if (!startEmitted) {
              emit({ type: 'start', claimCount: total, provider: effectiveProvider });
              startEmitted = true;
            }
            emit({
              type: 'claim_verified',
              index,
              claim: claim as unknown as Record<string, unknown>,
              verdict: verdict as unknown as Record<string, unknown>,
            });
          },
          pipelineConfig,
        );

        const claimCount = Array.isArray(result.claims) ? result.claims.length : 0;

        if (!startEmitted) {
          emit({ type: 'start', claimCount, provider: effectiveProvider });
        }

        emit({ type: 'complete', overallRisk: result.overallRisk, claimCount });

        // DIRECTIVE-NXTG-20260518-02: managed-inference cost telemetry for POST /scan/stream.
        const inputTokens = Math.ceil(text.length / 4);
        const outputTokens = Math.ceil(inputTokens * 0.3);
        const groundingCalls = claimCount;
        const costUsd = computeScanCost(inputTokens, outputTokens, groundingCalls, effectiveProvider);
        const costEvent: ManagedScanCostEvent = {
          scanId: randomUUID(),
          ts: new Date().toISOString(),
          tier: resolveTierFromRequest(keyId, request.headers['x-user-tier']),
          keyMode: 'managed',
          provider: effectiveProvider,
          modelId: PROVIDER_MODEL_IDS[effectiveProvider] ?? effectiveProvider,
          inputTokens,
          outputTokens,
          groundingCalls,
          costUsd,
          latencyMs: Date.now() - startTime,
          cacheHit: false,
        };
        getCostStore().recordManaged(costEvent);
        emitScanCostEvent(costEvent);
        appendScanCostLog(costEvent);
      } catch (err) {
        if (!startEmitted) {
          emit({ type: 'start', claimCount: 0, provider: effectiveProvider });
        }
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }

      reply
        .header('Content-Type', 'text/event-stream')
        .header('Cache-Control', 'no-cache')
        .header('Connection', 'keep-alive')
        .send(chunks.join(''));
    },
  );
}
