import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getCostStore } from '../store/costs.js';

interface CostsQuery {
  keyId?: string;
  provider?: string;
  from?: string;
  to?: string;
}

export async function costsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: CostsQuery }>(
    '/costs',
    {
      preHandler: requireApiKey,
      schema: {
        tags: ['Analytics'],
        summary: 'Per-scan cost estimates aggregated by provider and date',
        querystring: {
          type: 'object',
          properties: {
            keyId:    { type: 'string' },
            provider: { type: 'string' },
            from:     { type: 'string' },
            to:       { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { keyId, provider, from, to } = request.query;
      const store = getCostStore();
      const filter = { keyId, provider, from, to };
      const costs = store.getCosts(filter);
      const aggregate = store.getAggregate(filter);
      return reply.status(200).send({ costs, aggregate });
    },
  );
}
