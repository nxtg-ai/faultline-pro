import type { FastifyInstance } from 'fastify';
import { isAdminKeyId, requireApiKey, scanHistoryKeyScope } from '../plugins/auth.js';
import { getCostStore } from '../store/costs.js';

interface CostsQuery {
  keyId?: string;
  provider?: string;
  from?: string;
  to?: string;
}

interface PercentilesQuery {
  days?: string;
  tier?: 'enterprise' | 'pro' | 'personal' | 'free' | 'anon' | 'userkey';
}

export async function costsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: CostsQuery }>(
    '/costs',
    {
      config: { access: 'owner' },
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
      const { provider, from, to } = request.query;
      // A non-admin key sees only its own rows; ?keyId selects a key for admin only.
      let keyId = request.query.keyId;
      if (!isAdminKeyId(request.keyId)) {
        if (keyId !== undefined && keyId !== request.keyId) {
          return reply.status(403).send({ error: 'forbidden', message: 'A key can only read its own costs.' });
        }
        keyId = scanHistoryKeyScope(request);
      }
      const store = getCostStore();
      const filter = { keyId, provider, from, to };
      const costs = store.getCosts(filter);
      const aggregate = store.getAggregate(filter);
      return reply.status(200).send({ costs, aggregate });
    },
  );

  fastify.get<{ Querystring: PercentilesQuery }>(
    '/costs/percentiles',
    {
      config: { access: 'key' },
      preHandler: requireApiKey,
      schema: {
        tags: ['Analytics'],
        summary: 'p50/p90/p99 cost_usd and wall latency per managed-key scan over the last N days, optionally for one tier',
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'string' },
            tier: { type: 'string', enum: ['enterprise', 'pro', 'personal', 'free', 'anon', 'userkey'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const days = parseInt(request.query.days ?? '30', 10);
      const result = getCostStore().getPercentiles(isNaN(days) || days <= 0 ? 30 : days, request.query.tier);
      return reply.status(200).send(result);
    },
  );
}
