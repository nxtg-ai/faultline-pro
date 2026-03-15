import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';
import { scanRoutes } from './routes/scan.js';

/**
 * Build and configure a Fastify server instance.
 * Exported as a factory so tests can create isolated instances with inject().
 */
export function buildServer() {
  const fastify = Fastify({
    logger: false,
  });

  fastify.register(healthRoutes);
  fastify.register(scanRoutes);

  return fastify;
}
