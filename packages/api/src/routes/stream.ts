import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import type { PipelineConfig } from '@nxtg/faultline/cli/scan.js';
import { getCostStore, emitScanCostEvent, appendScanCostLog, resolveTierFromRequest, buildManagedCostEvent } from '../store/costs.js';
import { captureUsage } from '@nxtg/faultline/lib/usage-sink.js';

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
        // Grounded multi-model consensus (additive opt-in). When true, the
        // verify stage fans out to consensusProviders over shared sources and
        // claim_verified events carry the richer consensus verdict shape.
        consensus:            { type: 'boolean' },
        consensusProviders:   { type: 'array', items: { type: 'string', enum: PROVIDER_ENUM } },
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
 * Build the SSE response headers for a hijacked stream.
 *
 * BLG-fp-20260713-A (Wolf cert refute of ac99226): after reply.hijack() neither
 * reply.send() nor the onSend security-headers hook runs, so ANY header set via
 * reply.header() — most critically the CORS access-control-* headers that
 * @fastify/cors sets in its onRequest hook — never reaches the socket. Result:
 * every server-side probe (curl/inject) passes, but the browser EventSource on
 * faultline.nxtg.ai gets CORS-blocked and the prod web app breaks. We carry the
 * reply's already-accumulated headers (CORS) onto writeHead, re-apply the
 * security headers the onSend hook would have added, and let the SSE transport
 * headers win.
 */
function sseHeaders(reply: FastifyReply): Record<string, string> {
  const headers: Record<string, string> = {};
  // Carry headers already set on the reply (CORS from @fastify/cors's onRequest
  // hook lands here before the route handler runs).
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value == null) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  // Security headers normally added by server.ts onSend hook (skipped after hijack).
  headers['X-Content-Type-Options'] = 'nosniff';
  headers['X-Frame-Options'] = 'DENY';
  headers['Referrer-Policy'] = 'strict-origin-when-cross-origin';
  headers['X-XSS-Protection'] = '0';
  headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none'";
  // SSE transport headers win over anything carried above.
  headers['Content-Type'] = 'text/event-stream';
  headers['Cache-Control'] = 'no-cache';
  headers['Connection'] = 'keep-alive';
  headers['X-Accel-Buffering'] = 'no';
  return headers;
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
            provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'], description: 'Provider (default: gemini — the grounded, web-sourced default)' },
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
        : 'gemini';

      // TRUE SSE — write each event to the socket as produced (see POST handler
      // note). hijack() + X-Accel-Buffering:no defeat Fastify + proxy buffering.
      // sseHeaders() carries the CORS + security headers hijack would otherwise
      // drop (BLG-fp-20260713-A).
      reply.raw.writeHead(200, sseHeaders(reply));
      reply.hijack();
      const emit = (data: Record<string, unknown>): void => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      let startEmitted = false;
      const keyId = (request as unknown as { keyId?: string }).keyId ?? 'unknown';
      const startTime = Date.now();

      try {
        const { result, legs } = await captureUsage(() => scan(
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
        ));

        const claimCount = Array.isArray(result.claims) ? result.claims.length : 0;

        // Fallback: emit start if no claims were verified (0-claim edge case)
        if (!startEmitted) {
          emit({ type: 'start', claimCount, provider: effectiveProvider });
        }

        emit({ type: 'complete', overallRisk: result.overallRisk, claimCount });

        // BLG-CLX9-20260703-005: real measured fan-out cost (was a text-length
        // estimate priced on one effectiveProvider). Fire-and-forget — never blocks SSE.
        const costEvent = buildManagedCostEvent(legs, {
          text,
          provider: effectiveProvider,
          claimCount,
          tier: resolveTierFromRequest(keyId, request.headers['x-user-tier']),
          latencyMs: Date.now() - startTime,
        });
        getCostStore().recordManaged(costEvent);
        emitScanCostEvent(costEvent);
        appendScanCostLog(costEvent);
      } catch (err) {
        // BLG-fp-20260713-A: log raw for ops, emit a generic client-safe message.
        console.error(`/scan/stream GET failed for key ${keyId}:`, err);
        if (!startEmitted) {
          emit({ type: 'start', claimCount: 0, provider: effectiveProvider });
        }
        emit({ type: 'error', message: 'Scan failed — the verification service hit an error. Please retry.' });
      } finally {
        reply.raw.end();
      }
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
        : 'gemini';

      // TRUE SSE: write each event to the socket as it is produced. Previously
      // every event was pushed to an array and flushed in ONE .send() at scan
      // end — the client saw a ~27s freeze then all events at once (Asif eyes-on
      // UAT + fw streaming-truth probe, 2026-07-13). scan()'s onClaimVerified
      // already fires per claim; hijack() hands us the response lifecycle and
      // X-Accel-Buffering:no defeats Fly/proxy buffering so each write flushes.
      // sseHeaders() carries the CORS + security headers hijack would otherwise
      // drop (BLG-fp-20260713-A — Wolf cert refute).
      reply.raw.writeHead(200, sseHeaders(reply));
      reply.hijack();
      const emit = (data: Record<string, unknown>): void => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      let startEmitted = false;
      const keyId = (request as unknown as { keyId?: string }).keyId ?? 'unknown';
      const startTime = Date.now();

      try {
        const { result, legs } = await captureUsage(() => scan(
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
        ));

        const claimCount = Array.isArray(result.claims) ? result.claims.length : 0;

        if (!startEmitted) {
          emit({ type: 'start', claimCount, provider: effectiveProvider });
        }

        emit({ type: 'complete', overallRisk: result.overallRisk, claimCount });

        // BLG-CLX9-20260703-005: real measured fan-out cost (was a text-length
        // estimate priced on one effectiveProvider). Fire-and-forget — never blocks SSE.
        const costEvent = buildManagedCostEvent(legs, {
          text,
          provider: effectiveProvider,
          claimCount,
          tier: resolveTierFromRequest(keyId, request.headers['x-user-tier']),
          latencyMs: Date.now() - startTime,
        });
        getCostStore().recordManaged(costEvent);
        emitScanCostEvent(costEvent);
        appendScanCostLog(costEvent);
      } catch (err) {
        // BLG-fp-20260713-A: never leak the raw provider/engine error to the
        // client — log it for ops, emit a generic client-safe message.
        console.error(`/scan/stream POST failed for key ${keyId}:`, err);
        if (!startEmitted) {
          emit({ type: 'start', claimCount: 0, provider: effectiveProvider });
        }
        emit({ type: 'error', message: 'Scan failed — the verification service hit an error. Please retry.' });
      } finally {
        reply.raw.end();
      }
    },
  );
}
