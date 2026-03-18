import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { getAnalyticsStore } from '../store/analytics.js';

export async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/dashboard', { preHandler: requireAdmin }, async (_request, reply) => {
    return reply.status(200).send(getAnalyticsStore().getDashboard());
  });
}
