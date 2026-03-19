import type { FastifyInstance } from 'fastify';
import { getClaimIndex } from '../store/claims.js';

export async function claimsRoutes(fastify: FastifyInstance): Promise<void> {
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
}
