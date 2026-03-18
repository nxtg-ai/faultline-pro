import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { extractTextFromBuffer } from '@nxtg/faultline/cli/extract.js';
import { getAnalyticsStore } from '../store/analytics.js';
import type { RiskLevel } from '../store/analytics.js';
import { fireWebhookEvent } from '../store/webhooks.js';

const SUPPORTED_MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

export async function uploadRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/scan/upload',
    { preHandler: [requireApiKey, rateLimitScan] },
    async (request, reply) => {
      let buffer: Buffer | null = null;
      let mimetype = '';
      let truncated = false;
      let provider: Provider | undefined;

      try {
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === 'file') {
            if (part.fieldname === 'file') {
              const chunks: Buffer[] = [];
              for await (const chunk of part.file) {
                chunks.push(chunk as Buffer);
              }
              buffer = Buffer.concat(chunks);
              mimetype = part.mimetype;
              truncated = part.file.truncated;
            } else {
              await part.toBuffer();
            }
          } else {
            if (part.fieldname === 'provider') {
              provider = part.value as Provider;
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }

      if (buffer === null) {
        return reply.status(400).send({ error: 'No file field in multipart request.' });
      }

      if (truncated) {
        return reply.status(400).send({ error: 'File exceeds the 10MB limit.' });
      }

      if (!SUPPORTED_MIMES.includes(mimetype)) {
        return reply.status(400).send({
          error: `Unsupported file type: ${mimetype}. Supported: ${SUPPORTED_MIMES.join(', ')}`,
        });
      }

      let text: string;
      try {
        text = await extractTextFromBuffer(buffer, mimetype);
      } catch (extractErr) {
        const message = extractErr instanceof Error ? extractErr.message : String(extractErr);
        return reply.status(500).send({ error: message });
      }

      if (!text.trim()) {
        return reply.status(400).send({ error: 'Extracted text is empty.' });
      }

      try {
        const result = await scan(text, provider);
        getAnalyticsStore().record(request.keyId ?? 'unknown', result.overallRisk as RiskLevel);
        fireWebhookEvent('scan.complete', result);
        return reply.status(200).send(result);
      } catch (scanErr) {
        const message = scanErr instanceof Error ? scanErr.message : String(scanErr);
        fireWebhookEvent('scan.failed', { error: message });
        return reply.status(500).send({ error: message });
      }
    },
  );
}
