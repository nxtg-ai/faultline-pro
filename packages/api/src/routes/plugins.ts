/**
 * Plugin Marketplace API
 *
 * POST /plugins/publish  — Publish or update a plugin listing (auth required)
 * GET  /plugins/search   — Search the marketplace (public)
 * GET  /plugins/:id      — Get a plugin by ID (public)
 * POST /plugins/install  — Get install instructions and record a download
 */

import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import {
  getPluginRegistry,
  validatePublishInput,
} from '../store/plugin-registry.js';
import type { PublishInput, PluginType, SortOrder } from '../store/plugin-registry.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const PUBLISH_SCHEMA = {
  type: 'object',
  required: ['name', 'version', 'description', 'type'],
  properties: {
    name:        { type: 'string' },
    version:     { type: 'string' },
    description: { type: 'string' },
    type:        { type: 'string', enum: ['rule', 'provider', 'both'] },
    keywords:    { type: 'array', items: { type: 'string' }, maxItems: 5 },
    repoUrl:     { type: 'string' },
    readme:      { type: 'string' },
  },
  additionalProperties: false,
} as const;

const INSTALL_SCHEMA = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
  },
  additionalProperties: false,
} as const;

// ── Install instructions helper ───────────────────────────────────────────────

function makeInstallInstructions(name: string) {
  const configExample = JSON.stringify(
    { plugins: [name] },
    null,
    2,
  );

  return {
    npm:    `npm install ${name}`,
    yarn:   `yarn add ${name}`,
    pnpm:   `pnpm add ${name}`,
    config: `// .faultlinerc.json\n${configExample}`,
    docs:   'https://faultline.nxtg.ai/docs/plugins',
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function pluginMarketplaceRoutes(fastify: FastifyInstance): Promise<void> {
  const registry = getPluginRegistry();

  // ── POST /plugins/publish ─────────────────────────────────────────────────

  fastify.post<{ Body: PublishInput }>(
    '/plugins/publish',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Plugins'],
        summary: 'Publish or update a plugin listing in the marketplace',
        body: PUBLISH_SCHEMA,
      },
    },
    async (request, reply) => {
      const input = request.body;
      const author = request.keyId ?? 'anonymous';

      const errors = validatePublishInput(input);
      if (errors.length > 0) {
        return reply.status(400).send({ error: 'Validation failed', details: errors });
      }

      const result = registry.publish(input, author);

      if ('conflict' in result) {
        return reply.status(409).send({
          error: `Plugin "${input.name}" is already published by a different author.`,
          code: 'NAME_CONFLICT',
        });
      }

      return reply.status(result.created ? 201 : 200).send({
        plugin:  result.listing,
        created: result.created,
        message: result.created
          ? `Plugin "${input.name}" published successfully.`
          : `Plugin "${input.name}" updated to v${input.version}.`,
      });
    },
  );

  // ── GET /plugins/search ───────────────────────────────────────────────────

  fastify.get<{
    Querystring: { q?: string; type?: string; sort?: string; limit?: string; offset?: string };
  }>(
    '/plugins/search',
    {
      schema: {
        tags: ['Plugins'],
        summary: 'Search the plugin marketplace',
        querystring: {
          type: 'object',
          properties: {
            q:      { type: 'string', description: 'Text search across name, description, keywords' },
            type:   { type: 'string', enum: ['rule', 'provider', 'both'], description: 'Filter by plugin type' },
            sort:   { type: 'string', enum: ['downloads', 'recent', 'name'], description: 'Sort order (default: downloads)' },
            limit:  { type: 'string', description: 'Results per page (default: 20, max: 50)' },
            offset: { type: 'string', description: 'Pagination offset' },
          },
        },
      },
    },
    async (request) => {
      const { q, type, sort, limit, offset } = request.query;
      return registry.search({
        q,
        type:   type as PluginType | undefined,
        sort:   sort as SortOrder | undefined,
        limit:  limit  ? parseInt(limit,  10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });
    },
  );

  // ── GET /plugins/:id ──────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    '/plugins/:id',
    {
      schema: {
        tags: ['Plugins'],
        summary: 'Get a plugin listing by ID',
      },
    },
    async (request, reply) => {
      const plugin = registry.getById(request.params.id);
      if (!plugin) {
        return reply.status(404).send({ error: 'Plugin not found', code: 'NOT_FOUND' });
      }
      return plugin;
    },
  );

  // ── POST /plugins/install ─────────────────────────────────────────────────

  fastify.post<{ Body: { name: string } }>(
    '/plugins/install',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Plugins'],
        summary: 'Get install instructions and record a download for a plugin',
        body: INSTALL_SCHEMA,
      },
    },
    async (request, reply) => {
      const { name } = request.body;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return reply.status(400).send({ error: 'name is required' });
      }

      const plugin = registry.getByName(name.trim());
      if (!plugin) {
        return reply.status(404).send({
          error: `Plugin "${name}" not found in the marketplace.`,
          code: 'NOT_FOUND',
          suggestion: 'Search the marketplace with GET /plugins/search?q=<term>',
        });
      }

      registry.incrementDownloads(plugin.id);

      return {
        plugin,
        install: makeInstallInstructions(plugin.name),
      };
    },
  );
}
