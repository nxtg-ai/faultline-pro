import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { scan } from '@nxtg/faultline/cli/scan.js';

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

interface ScanBody {
  text: string;
  provider?: 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';
}

export async function scanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ScanBody }>(
    '/scan',
    {
      preHandler: requireApiKey,
      schema: { body: BODY_SCHEMA },
    },
    async (request, reply) => {
      const { text, provider } = request.body;

      try {
        const result = await scan(text, provider);
        return reply.status(200).send(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );
}
