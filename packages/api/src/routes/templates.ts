import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getTemplateStore } from '../store/templates.js';

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
  process.stderr.write('[templateRoutes] plugin called\n');
  fastify.post<{ Body: CreateTemplateBody }>(
    '/templates',
    {
      preHandler: requireApiKey,
      schema: { body: CREATE_SCHEMA },
    },
    async (request, reply) => {
      const { name, provider, rules, failOn, description } = request.body;
      const template = getTemplateStore().create(name, { provider, rules, failOn, description });
      return reply.status(201).send(template);
    },
  );
  process.stderr.write('[templateRoutes] POST /templates registered\n');

  fastify.get('/templates', { preHandler: requireApiKey }, async (_request, reply) => {
    return reply.status(200).send(getTemplateStore().list());
  });

  fastify.delete<{ Params: { id: string } }>(
    '/templates/:id',
    {
      preHandler: requireApiKey,
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const deleted = getTemplateStore().delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Template not found.' });
      }
      return reply.status(204).send();
    },
  );
}
