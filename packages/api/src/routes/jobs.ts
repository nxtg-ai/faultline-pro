import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getJobStore } from '../store/jobs.js';
import type { Provider } from '../store/jobs.js';

const POST_SCHEMA = {
  type: 'object',
  required: ['text', 'schedule'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 50000 },
    provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
    schedule: { type: 'string', minLength: 1, maxLength: 100 },
    webhookUrl: { type: 'string', maxLength: 2048 },
  },
  additionalProperties: false,
} as const;

interface CreateJobBody {
  text: string;
  provider?: Provider;
  schedule: string;
  webhookUrl?: string;
}

export async function jobRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CreateJobBody }>(
    '/jobs',
    {
      preHandler: requireApiKey,
      schema: { tags: ['Jobs'], summary: 'Create a scheduled scan job', body: POST_SCHEMA },
    },
    async (request, reply) => {
      const { text, provider, schedule, webhookUrl } = request.body;
      const job = getJobStore().create({ text, provider, schedule, webhookUrl });
      return reply.status(201).send(job);
    },
  );

  fastify.get('/jobs', { preHandler: requireApiKey, schema: { tags: ['Jobs'], summary: 'List all scheduled scan jobs' } }, async (_request, reply) => {
    return reply.status(200).send(getJobStore().list());
  });

  fastify.delete<{ Params: { id: string } }>(
    '/jobs/:id',
    {
      preHandler: requireApiKey,
      schema: {
        tags: ['Jobs'],
        summary: 'Delete a scheduled scan job',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const deleted = getJobStore().delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Job not found.' });
      }
      return reply.status(204).send();
    },
  );
}
