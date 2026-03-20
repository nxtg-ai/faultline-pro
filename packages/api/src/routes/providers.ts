/**
 * Provider routes (D-124 + D-125)
 *
 * POST /providers/register — register a custom external provider plugin
 * GET  /providers/health   — health dashboard for all tracked providers
 */

import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { requireAdmin } from '../plugins/auth.js';
import { getProviderRegistry } from '../store/providers.js';
import { getCircuitBreaker, PROVIDER_CHAIN } from '../store/circuit-breaker.js';

const REGISTER_SCHEMA = {
  type: 'object',
  required: ['name', 'endpoint'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9_-]+$' },
    endpoint: { type: 'string', format: 'uri', maxLength: 2048 },
    authHeader: { type: 'string', maxLength: 512 },
  },
  additionalProperties: false,
} as const;

interface RegisterBody {
  name: string;
  endpoint: string;
  authHeader?: string;
}

export async function providerRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /providers/register
   * Register an external HTTP provider plugin.
   */
  fastify.post<{ Body: RegisterBody }>(
    '/providers/register',
    {
      preHandler: [requireAdmin],
      schema: { tags: ['Providers'], summary: 'Register a custom external provider plugin (admin)', body: REGISTER_SCHEMA },
    },
    async (request, reply) => {
      const { name, endpoint, authHeader } = request.body;

      // Prevent overwriting built-in chain providers
      if (PROVIDER_CHAIN.includes(name as Parameters<typeof PROVIDER_CHAIN['includes']>[0])) {
        return reply.status(409).send({ error: `Provider name "${name}" is reserved.` });
      }

      const registry = getProviderRegistry();
      registry.registerPlugin({ name, endpoint, authHeader });

      return reply.status(201).send({
        name,
        endpoint,
        registeredAt: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /providers/health
   * Returns health metrics for all tracked providers (built-in + custom).
   */
  fastify.get(
    '/providers/health',
    { preHandler: [requireApiKey], schema: { tags: ['Providers'], summary: 'Health metrics for all built-in and plugin providers' } },
    async (_request, reply) => {
      const registry = getProviderRegistry();
      const cb = getCircuitBreaker();
      const cbStatus = cb.getStatus();
      const healthSnapshot = registry.getHealthSnapshot();

      // Build combined health view: circuit-breaker status + latency/error data
      const builtIn = PROVIDER_CHAIN.map(name => ({
        name,
        type: 'built-in' as const,
        circuitBreaker: cbStatus[name],
        metrics: healthSnapshot[name] ?? null,
      }));

      const plugins = registry.listPlugins().map(p => ({
        name: p.name,
        type: 'plugin' as const,
        endpoint: p.endpoint,
        circuitBreaker: null,
        metrics: healthSnapshot[p.name] ?? null,
      }));

      return reply.status(200).send({
        providers: [...builtIn, ...plugins],
        generatedAt: new Date().toISOString(),
      });
    },
  );
}
