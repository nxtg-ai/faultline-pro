import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { getWebhookStore } from '../store/webhooks.js';
import type { WebhookEvent } from '../store/webhooks.js';

const VALID_EVENTS: WebhookEvent[] = ['scan.complete', 'scan.failed'];

const CREATE_BODY_SCHEMA = {
  type: 'object',
  required: ['url', 'events'],
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 2048 },
    events: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: VALID_EVENTS },
    },
    secret: { type: 'string', minLength: 1, maxLength: 128 },
  },
  additionalProperties: false,
} as const;

interface CreateWebhookBody {
  url: string;
  events: WebhookEvent[];
  secret?: string;
}

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CreateWebhookBody }>(
    '/webhooks',
    { preHandler: requireAdmin, schema: { body: CREATE_BODY_SCHEMA } },
    async (request, reply) => {
      const { url, events, secret } = request.body;
      const entry = getWebhookStore().create(url, events, secret);
      return reply.status(201).send(entry);
    },
  );

  fastify.get('/webhooks', { preHandler: requireAdmin }, async (_request, reply) => {
    return reply.status(200).send(getWebhookStore().list());
  });

  fastify.delete<{ Params: { id: string } }>(
    '/webhooks/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const deleted = getWebhookStore().delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Webhook not found.' });
      }
      return reply.status(204).send();
    },
  );
}
