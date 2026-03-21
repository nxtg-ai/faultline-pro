import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { scan } from '@nxtg/faultline/cli/scan.js';

type ScanProvider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

const VALID_PROVIDERS = new Set<ScanProvider>(['gemini', 'openai', 'claude', 'perplexity', 'mock']);

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
      preHandler: [requireApiKey],
      schema: {
        tags: ['Scan'],
        summary: 'Stream scan results via Server-Sent Events (progressive per-claim delivery)',
        description: 'Runs a scan and streams progress events (start → claim_verified × N → complete) in SSE format. claim_verified events are emitted progressively as each claim is verified.',
        querystring: {
          type: 'object',
          properties: {
            text:     { type: 'string', minLength: 1, maxLength: 50000, description: 'Text to scan' },
            provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'], description: 'Provider (default: mock)' },
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
        : 'mock';

      const chunks: string[] = [];
      const emit = (data: Record<string, unknown>): void => {
        chunks.push(`data: ${JSON.stringify(data)}\n\n`);
      };

      let startEmitted = false;

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
