import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { getScanCache } from '../store/cache.js';

export async function cacheRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/cache/stats', { preHandler: [requireAdmin], schema: { tags: ['Cache'], summary: 'Get scan result cache statistics (size, hit rate, TTL)' } }, async (_request, reply) => {
    return reply.status(200).send(getScanCache().stats());
  });

  fastify.delete('/cache', { preHandler: [requireAdmin], schema: { tags: ['Cache'], summary: 'Flush all cached scan results (admin)' } }, async (_request, reply) => {
    getScanCache().flush();
    return reply.status(204).send();
  });
}
