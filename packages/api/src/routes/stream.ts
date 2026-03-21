import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { scan } from '@nxtg/faultline/cli/scan.js';

type ScanProvider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

const VALID_PROVIDERS = new Set<ScanProvider>(['gemini', 'openai', 'claude', 'perplexity', 'mock']);

/**
 * N-134 — Server-Sent Events scan streaming.
 * GET /scan/stream?text=...&provider=mock
 *
 * Streams scan progress as SSE events:
 *   data: {"type":"start","claimCount":N,"provider":"mock"}
 *   data: {"type":"claim_verified","index":0,"claim":{...},"verdict":{...}}  (one per claim)
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
        summary: 'Stream scan results via Server-Sent Events',
        description: 'Runs a scan and streams progress events (start → claim_verified × N → complete) in SSE format.',
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

      try {
        const result = await scan(text, effectiveProvider);
        const claims = Array.isArray(result.claims) ? result.claims : [];

        emit({ type: 'start', claimCount: claims.length, provider: effectiveProvider });

        for (let i = 0; i < claims.length; i++) {
          const claim = claims[i] as unknown as Record<string, unknown>;
          const verdict = (result.verifications as Record<string, unknown>)[claim['id'] as string] ?? null;
          emit({ type: 'claim_verified', index: i, claim, verdict });
        }

        emit({ type: 'complete', overallRisk: result.overallRisk, claimCount: claims.length });
      } catch (err) {
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
