import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { extractTextFromBuffer } from '@nxtg/faultline/cli/extract.js';
import { commitClaims, engineVerifyCap, reserveClaims } from '../plugins/claim-meter.js';
import { getAnalyticsStore } from '../store/analytics.js';
import type { RiskLevel } from '../store/analytics.js';
import { fireWebhookEvent } from '../store/webhooks.js';
import { issueScanId } from '../lib/scan-access.js';
import { requestOwner } from '../lib/cache-caller.js';

const SUPPORTED_MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

export async function uploadRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/scan/upload',
    { config: { access: 'key' }, preHandler: [requireApiKey, rateLimitScan, reserveClaims(engineVerifyCap())], schema: { tags: ['Scan'], summary: 'Upload PDF or image for OCR scan' } },
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
        const delivered = issueScanId(result, request.keyId);
        commitClaims(request, delivered.scanId, result, provider ?? 'gemini');
        fireWebhookEvent('scan.complete', delivered, requestOwner(request));
        return reply.status(200).send(delivered);
      } catch (scanErr) {
        const message = scanErr instanceof Error ? scanErr.message : String(scanErr);
        fireWebhookEvent('scan.failed', { error: message }, requestOwner(request));
        return reply.status(500).send({ error: message });
      }
    },
  );
}
