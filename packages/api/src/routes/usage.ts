import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getUsageMeter } from '../store/usage.js';

export async function usageRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/usage', { preHandler: requireApiKey }, async (request, reply) => {
    const keyId = request.keyId ?? 'unknown';
    const meter = getUsageMeter();
    return reply.status(200).send({ keyId, usage: meter.getUsage(keyId) });
  });
}
