import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { getAnalyticsStore } from '../store/analytics.js';
import { getCircuitBreaker } from '../store/circuit-breaker.js';
import { getKeyStore } from '../store/keys.js';
import { getScanHistory } from '../store/scan-history.js';

export async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/dashboard', { preHandler: requireAdmin }, async (_request, reply) => {
    const analytics = getAnalyticsStore().getDashboard();
    const providerStatus = getCircuitBreaker().getStatus();
    const activeKeys = getKeyStore().list().length;
    const scanFeed = getScanHistory().getRecent(10);

    return reply.status(200).send({
      ...analytics,
      activeKeys,
      scanFeed,
      providerStatus,
    });
  });
}
