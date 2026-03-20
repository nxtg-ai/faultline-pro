/**
 * Cache Warmup routes (D-164)
 *
 * POST   /cache/warmup                  — register a warmup target (admin)
 * GET    /cache/warmup                  — list all targets (admin)
 * GET    /cache/warmup/summary          — aggregate stats (admin)
 * POST   /cache/warmup/run              — warm ALL enabled targets now (admin)
 * GET    /cache/warmup/:id              — get a single target (admin)
 * PATCH  /cache/warmup/:id             — update target (admin)
 * DELETE /cache/warmup/:id             — delete target (admin)
 * POST   /cache/warmup/:id/run         — warm a specific target now (admin)
 * GET    /cache/warmup/:id/history     — run history for a target (admin)
 */

import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import {
  getWarmupStore,
  getCacheWarmer,
  type WarmupProvider,
} from '../store/cache-warmup.js';
import { getScanHistory } from '../store/scan-history.js';

export async function cacheWarmupRoutes(fastify: FastifyInstance): Promise<void> {

  /**
   * POST /cache/warmup — register a new warmup target
   */
  fastify.post<{
    Body: { name: string; text: string; provider?: WarmupProvider; priority?: number; enabled?: boolean };
  }>(
    '/cache/warmup',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Cache'],
        summary: 'Register a cache warmup target (admin)',
        body: {
          type: 'object',
          required: ['name', 'text'],
          properties: {
            name:     { type: 'string', minLength: 1, maxLength: 128 },
            text:     { type: 'string', minLength: 1, maxLength: 200_000 },
            provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
            priority: { type: 'integer', minimum: 0, maximum: 1000 },
            enabled:  { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const target = getWarmupStore().create(request.body, request.keyId ?? 'admin');
        return reply.status(201).send(target);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * GET /cache/warmup/summary — aggregate stats
   */
  fastify.get(
    '/cache/warmup/summary',
    {
      preHandler: [requireAdmin],
      schema: { tags: ['Cache'], summary: 'Cache warmup aggregate statistics (admin)' },
    },
    async (_request, reply) => {
      return reply.send(getWarmupStore().getSummary());
    },
  );

  /**
   * POST /cache/warmup/run — warm ALL enabled targets immediately
   */
  fastify.post(
    '/cache/warmup/run',
    {
      preHandler: [requireAdmin],
      schema: { tags: ['Cache'], summary: 'Warm all enabled cache warmup targets now (admin)' },
    },
    async (_request, reply) => {
      // Fire-and-forget for large warmup sets; return 202 immediately
      const results = await getCacheWarmer().warmAll();
      const succeeded = results.filter(r => r.run.status === 'done').length;
      const failed    = results.filter(r => r.run.status === 'error').length;
      return reply.status(207).send({
        message:   `Warmed ${succeeded} target(s), ${failed} error(s).`,
        succeeded,
        failed,
        results:   results.map(r => ({
          targetId:   r.targetId,
          name:       r.name,
          status:     r.run.status,
          durationMs: r.run.durationMs,
          error:      r.run.error,
        })),
        triggeredAt: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /cache/warmup — list targets
   */
  fastify.get<{ Querystring: { enabled?: string } }>(
    '/cache/warmup',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Cache'],
        summary: 'List cache warmup targets (admin)',
        querystring: {
          type: 'object',
          properties: { enabled: { type: 'string', enum: ['true', 'false'] } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const enabledOnly = request.query.enabled === 'true';
      const targets = getWarmupStore().list(enabledOnly);
      return reply.send({ targets, total: targets.length });
    },
  );

  /**
   * GET /cache/warmup/suggestions — top-N most-scanned texts not yet warmed
   */
  fastify.get<{ Querystring: { limit?: string } }>(
    '/cache/warmup/suggestions',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Cache'],
        summary: 'Suggest frequently scanned texts as warmup candidates (admin)',
        querystring: {
          type: 'object',
          properties: { limit: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit ?? '10', 10) || 10, 50);
      const existing = new Set(getWarmupStore().list().map(t => t.text));

      // Aggregate scan history by textHash → pick top-frequency entries not already warmed
      const history = getScanHistory().getRecent(1000);
      const freq = new Map<string, { text: string; count: number; provider: string }>();
      for (const entry of history) {
        const key = entry.textHash + '|' + entry.provider;
        if (!freq.has(key)) {
          freq.set(key, { text: entry.textPreview, count: 0, provider: entry.provider });
        }
        freq.get(key)!.count++;
      }

      const suggestions = [...freq.values()]
        .filter(e => !existing.has(e.text))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map(e => ({ text: e.text, provider: e.provider, scanCount: e.count }));

      return reply.send({ suggestions, total: suggestions.length });
    },
  );

  /**
   * GET /cache/warmup/:id — single target (must be before /:id/run)
   */
  fastify.get<{ Params: { id: string } }>(
    '/cache/warmup/:id',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Cache'],
        summary: 'Get a cache warmup target (admin)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const target = getWarmupStore().get(request.params.id);
      if (!target) return reply.status(404).send({ error: 'Warmup target not found.' });
      return reply.send(target);
    },
  );

  /**
   * PATCH /cache/warmup/:id — update target
   */
  fastify.patch<{
    Params: { id: string };
    Body: { name?: string; enabled?: boolean; priority?: number; provider?: WarmupProvider };
  }>(
    '/cache/warmup/:id',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Cache'],
        summary: 'Update a cache warmup target (admin)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          properties: {
            name:     { type: 'string', minLength: 1, maxLength: 128 },
            enabled:  { type: 'boolean' },
            priority: { type: 'integer', minimum: 0, maximum: 1000 },
            provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const target = getWarmupStore().update(request.params.id, request.body);
      if (!target) return reply.status(404).send({ error: 'Warmup target not found.' });
      return reply.send(target);
    },
  );

  /**
   * DELETE /cache/warmup/:id — remove target
   */
  fastify.delete<{ Params: { id: string } }>(
    '/cache/warmup/:id',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Cache'],
        summary: 'Delete a cache warmup target (admin)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const deleted = getWarmupStore().delete(request.params.id);
      if (!deleted) return reply.status(404).send({ error: 'Warmup target not found.' });
      return reply.status(204).send();
    },
  );

  /**
   * POST /cache/warmup/:id/run — warm a single target now
   */
  fastify.post<{ Params: { id: string } }>(
    '/cache/warmup/:id/run',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Cache'],
        summary: 'Trigger a cache warmup for a specific target (admin)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (request, reply) => {
      const target = getWarmupStore().get(request.params.id);
      if (!target) return reply.status(404).send({ error: 'Warmup target not found.' });
      const run = await getCacheWarmer().warmOne(request.params.id);
      return reply.status(run.status === 'done' ? 200 : 502).send({
        targetId:   target.id,
        name:       target.name,
        run,
        cacheHit:   run.status === 'done',
      });
    },
  );

  /**
   * GET /cache/warmup/:id/history — run history for one target
   */
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/cache/warmup/:id/history',
    {
      preHandler: [requireAdmin],
      schema: {
        tags: ['Cache'],
        summary: 'Get run history for a cache warmup target (admin)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: { limit: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const target = getWarmupStore().get(request.params.id);
      if (!target) return reply.status(404).send({ error: 'Warmup target not found.' });
      const limit = Math.min(parseInt(request.query.limit ?? '20', 10) || 20, 100);
      return reply.send({
        targetId: target.id,
        name:     target.name,
        history:  target.history.slice(0, limit),
        total:    target.history.length,
      });
    },
  );
}
