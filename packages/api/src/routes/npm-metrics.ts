/**
 * npm Download Metrics routes (N-185)
 *
 * GET /npm/downloads           — overview across all tracked packages
 * GET /npm/downloads/:package  — daily downloads for a single package
 * GET /npm/trend/:package      — weekly trend for a single package
 * POST /npm/poll               — trigger an immediate poll (admin only)
 */

import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { requireAdmin } from '../plugins/auth.js';
import { getNpmMetricsStore } from '../store/npm-metrics.js';

export async function npmMetricsRoutes(fastify: FastifyInstance): Promise<void> {
  // ── GET /npm/downloads — overview ──────────────────────────────────────────
  fastify.get(
    '/npm/downloads',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Analytics'],
        summary: 'npm download overview across all tracked packages',
      },
    },
    async (_request, reply) => {
      const overview = getNpmMetricsStore().getOverview();
      return reply.send(overview);
    },
  );

  // ── GET /npm/downloads/:package — per-package daily ────────────────────────
  fastify.get<{ Params: { package: string } }>(
    '/npm/downloads/:package',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Analytics'],
        summary: 'Daily download counts for a specific npm package',
        params: {
          type: 'object',
          properties: {
            package: { type: 'string' },
          },
          required: ['package'],
        },
      },
    },
    async (request, reply) => {
      const pkg = decodeURIComponent(request.params.package);
      const data = getNpmMetricsStore().get(pkg);
      if (!data) {
        return reply.status(404).send({ error: `No data for package: ${pkg}` });
      }
      return reply.send(data);
    },
  );

  // ── GET /npm/trend/:package — weekly trend ─────────────────────────────────
  fastify.get<{ Params: { package: string }; Querystring: { weeks?: string } }>(
    '/npm/trend/:package',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Analytics'],
        summary: 'Weekly download trend for a specific npm package',
        params: {
          type: 'object',
          properties: {
            package: { type: 'string' },
          },
          required: ['package'],
        },
        querystring: {
          type: 'object',
          properties: {
            weeks: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const pkg = decodeURIComponent(request.params.package);
      const weeks = parseInt(request.query.weeks ?? '12', 10);
      const trend = getNpmMetricsStore().getWeeklyTrend(pkg, weeks);
      return reply.send({ package: pkg, weeks, trend });
    },
  );

  // ── POST /npm/poll — manual trigger ────────────────────────────────────────
  fastify.post(
    '/npm/poll',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Analytics'],
        summary: 'Trigger an immediate npm download poll (admin only)',
      },
    },
    async (_request, reply) => {
      await getNpmMetricsStore().poll();
      return reply.send({ status: 'polled', fetchedAt: getNpmMetricsStore().lastPollTime });
    },
  );
}
