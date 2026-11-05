import type { FastifyInstance } from 'fastify';
import { requireApiKey, isAdminKeyId } from '../plugins/auth.js';
import { engineVerifyCap, requireClaimHeadroom } from '../plugins/claim-meter.js';
import { enforceProviderSpendCap, resolveSpendCapTier } from '../plugins/provider-spend-cap.js';
import { getJobStore } from '../store/jobs.js';
import type { Provider } from '../store/jobs.js';
import { outboundUrlRefusal } from '../lib/outbound-url.js';
import { requestOwner } from '../lib/cache-caller.js';

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
      config: { access: 'owner' },
      preHandler: [requireApiKey, enforceProviderSpendCap, requireClaimHeadroom(engineVerifyCap())],
      schema: { tags: ['Jobs'], summary: 'Create a scheduled scan job', body: POST_SCHEMA },
    },
    async (request, reply) => {
      const { text, provider, schedule, webhookUrl } = request.body;
      const refusal = webhookUrl === undefined ? null : await outboundUrlRefusal(webhookUrl);
      if (refusal) return reply.status(400).send({ error: refusal });
      const job = getJobStore().create({
        text, provider, schedule, webhookUrl, owner: requestOwner(request),
        spendCapTier: resolveSpendCapTier(request.keyId, request.headers['x-user-tier']),
      });
      return reply.status(201).send(job);
    },
  );

  // A key lists and deletes only the jobs it created; an admin key, any job.
  // Before, any key could read every job's text and callback URL (codex seat, 84cf8c8).
  fastify.get('/jobs', { config: { access: 'owner' }, preHandler: requireApiKey, schema: { tags: ['Jobs'], summary: "List your key's scheduled scan jobs (admin: all)" } }, async (request, reply) => {
    const store = getJobStore();
    return reply.status(200).send(isAdminKeyId(request.keyId) ? store.list() : store.listOwnedBy(request.keyId ?? ''));
  });

  fastify.delete<{ Params: { id: string } }>(
    '/jobs/:id',
    {
      config: { access: 'owner' },
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
      const owner = getJobStore().ownerOf(request.params.id);
      const mine = owner !== null && owner !== 'public' && owner.keyId === request.keyId;
      if (!isAdminKeyId(request.keyId) && !mine) return reply.status(404).send({ error: 'Job not found.' });
      const deleted = getJobStore().delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Job not found.' });
      }
      return reply.status(204).send();
    },
  );
}
