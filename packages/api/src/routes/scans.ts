import type { FastifyInstance } from 'fastify';
import { getScanHistory } from '../store/scan-history.js';

export async function scansRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Querystring: {
      q?: string;
      from?: string;
      to?: string;
      provider?: string;
      risk?: string;
      cursor?: string;
      limit?: string;
    };
  }>(
    '/scans/search',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q:        { type: 'string' },
            from:     { type: 'string' },
            to:       { type: 'string' },
            provider: { type: 'string' },
            risk:     { type: 'string' },
            cursor:   { type: 'string' },
            limit:    { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { q, from, to, provider, risk, cursor, limit } = request.query;
      const limitNum = limit ? Math.min(parseInt(limit, 10) || 20, 100) : 20;
      const result = getScanHistory().search({ q, from, to, provider, risk, cursor, limit: limitNum });
      return reply.status(200).send({
        scans: result.entries,
        nextCursor: result.nextCursor,
        total: result.entries.length,
      });
    },
  );
}
