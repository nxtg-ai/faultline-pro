import type { FastifyInstance } from 'fastify';
import { getClaimIndex, computeAttributionConfidence } from '../store/claims.js';

export async function claimsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Querystring: {
      text?: string;
      verdict?: string;
      from?: string;
      to?: string;
      source?: string;
      limit?: string;
    };
  }>(
    '/claims',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            verdict: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            source: { type: 'string' },
            limit: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { text, verdict, from, to, source, limit } = request.query;
      const limitNum = limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50;
      const results = getClaimIndex().search({ text, verdict, from, to, source, limit: limitNum });
      return reply.status(200).send({
        claims: results.map((r) => ({
          id: r.id,
          text: r.originalText,
          normalizedText: r.normalizedText,
          claimType: r.claimType,
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen,
          frequency: r.frequency,
          lastVerdict: r.lastVerdict,
          sourceCount: r.sources.length,
        })),
        total: results.length,
      });
    },
  );

  fastify.get('/claims/trending', async (_request, reply) => {
    const index = getClaimIndex();

    return reply.status(200).send({
      trending: index.getTrending(20).map((r) => ({
        text: r.originalText,
        normalizedText: r.normalizedText,
        frequency: r.frequency,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        lastVerdict: r.lastVerdict,
      })),
      emerging: index.getEmerging(10).map((r) => ({
        text: r.originalText,
        normalizedText: r.normalizedText,
        frequency: r.frequency,
        firstSeen: r.firstSeen,
        lastVerdict: r.lastVerdict,
      })),
      verdictChanged: index.getVerdictChanges(10),
    });
  });

  fastify.get<{ Params: { id: string } }>(
    '/claims/:id/attribution',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const record = getClaimIndex().getById(request.params.id);
      if (!record) {
        return reply.status(404).send({ error: 'Claim not found.' });
      }

      const attributionConfidence = computeAttributionConfidence(record);

      return reply.status(200).send({
        id: record.id,
        claim: record.originalText,
        claimType: record.claimType,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        frequency: record.frequency,
        lastVerdict: record.lastVerdict,
        attributionConfidence,
        attributionChain: {
          sources: record.sources,
          scanHistory: record.verdicts,
        },
      });
    },
  );
}
