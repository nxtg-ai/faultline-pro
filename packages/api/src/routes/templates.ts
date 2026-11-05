import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getTemplateStore } from '../store/templates.js';
import { ownedOnly, ownsOrAdmin } from '../lib/ownership.js';

type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

const CREATE_SCHEMA = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
    rules: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    failOn: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    description: { type: 'string', maxLength: 500 },
  },
  additionalProperties: false,
} as const;

interface CreateTemplateBody {
  name: string;
  provider?: Provider;
  rules?: string[];
  failOn?: 'critical' | 'high' | 'medium' | 'low';
  description?: string;
}

export async function templateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: CreateTemplateBody }>(
    '/templates',
    {
      config: { access: 'owner' },
      preHandler: requireApiKey,
      schema: { tags: ['Templates'], summary: 'Create a reusable scan configuration template', body: CREATE_SCHEMA },
    },
    async (request, reply) => {
      const { name, provider, rules, failOn, description } = request.body;
      const template = getTemplateStore().create(name, { provider, rules, failOn, description }, request.keyId);
      return reply.status(201).send(template);
    },
  );

  fastify.get('/templates', { config: { access: 'owner' }, preHandler: requireApiKey, schema: { tags: ['Templates'], summary: "List the caller's saved scan templates (admin: all)" } }, async (request, reply) => {
    return reply.status(200).send(ownedOnly(request, getTemplateStore().list(), (t) => t.keyId));
  });

  fastify.delete<{ Params: { id: string } }>(
    '/templates/:id',
    {
      config: { access: 'owner' },
      preHandler: requireApiKey,
      schema: {
        tags: ['Templates'],
        summary: 'Delete a scan template by ID',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const template = getTemplateStore().get(request.params.id);
      if (!template || !ownsOrAdmin(request, template.keyId)) {
        return reply.status(404).send({ error: 'Template not found.' });
      }
      getTemplateStore().delete(template.id);
      return reply.status(204).send();
    },
  );
}
