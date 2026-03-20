import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import {
  getRuleStore,
  validateRuleInput,
  evaluateRule,
} from '../store/rules.js';
import type { ClaimLike } from '../store/rules.js';

type ClaimShape = ClaimLike;

export async function rulesRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /rules — create a rule (admin)
  fastify.post(
    '/rules',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Claims'],
        summary: 'Create a custom verification rule',
        description: 'Define rules in JSON. YAML input is supported by sending raw YAML as text/plain (server parses it). Rules run during scans on each extracted claim.',
        security: [{ apiKey: [] }],
        body: {
          type: 'object',
          required: ['name', 'description', 'condition'],
          properties: {
            name:        { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: 'string', maxLength: 500 },
            condition:   { type: 'string' },
            params:      { type: 'object' },
            severity:    { type: 'string' },
            enabled:     { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      let input: unknown = request.body;

      // Allow raw YAML string body (content-type: text/plain)
      if (typeof input === 'string') {
        try {
          const { parse } = await import('yaml');
          input = parse(input);
        } catch {
          return reply.status(400).send({ error: 'Invalid YAML body.' });
        }
      }

      let validated;
      try {
        validated = validateRuleInput(input);
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      const rule = getRuleStore().create(validated);
      return reply.status(201).send(rule);
    },
  );

  // GET /rules — list all rules (admin)
  fastify.get(
    '/rules',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Claims'],
        summary: 'List all custom verification rules',
        security: [{ apiKey: [] }],
      },
    },
    async (_request, reply) => {
      const rules = getRuleStore().list();
      return reply.send({ total: rules.length, rules });
    },
  );

  // GET /rules/:id — get a rule (admin)
  fastify.get<{ Params: { id: string } }>(
    '/rules/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Claims'],
        summary: 'Get a custom rule by ID',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const rule = getRuleStore().get(request.params.id);
      if (!rule) return reply.status(404).send({ error: 'Rule not found.' });
      return reply.send(rule);
    },
  );

  // PATCH /rules/:id — update a rule (admin)
  fastify.patch<{ Params: { id: string } }>(
    '/rules/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Claims'],
        summary: 'Update a custom rule',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            name:        { type: 'string', minLength: 1 },
            description: { type: 'string' },
            severity:    { type: 'string' },
            enabled:     { type: 'boolean' },
            params:      { type: 'object' },
          },
          additionalProperties: false,
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const updated = getRuleStore().update(request.params.id, request.body as Record<string, unknown>);
      if (!updated) return reply.status(404).send({ error: 'Rule not found.' });
      return reply.send(updated);
    },
  );

  // DELETE /rules/:id — delete a rule (admin)
  fastify.delete<{ Params: { id: string } }>(
    '/rules/:id',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Claims'],
        summary: 'Delete a custom rule',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const deleted = getRuleStore().delete(request.params.id);
      if (!deleted) return reply.status(404).send({ error: 'Rule not found.' });
      return reply.status(204).send();
    },
  );

  // POST /rules/:id/test — dry-run a rule against provided claims (admin)
  fastify.post<{ Params: { id: string }; Body: { claims: ClaimShape[] } }>(
    '/rules/:id/test',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Claims'],
        summary: 'Test a rule against provided claims',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          required: ['claims'],
          properties: {
            claims: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text:    { type: 'string' },
                  type:    { type: 'string' },
                  sources: { type: 'array' },
                },
                additionalProperties: true,
              },
            },
          },
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const rule = getRuleStore().get(request.params.id);
      if (!rule) return reply.status(404).send({ error: 'Rule not found.' });
      const violations = evaluateRule(rule, request.body.claims);
      return reply.send({
        ruleId:     rule.id,
        ruleName:   rule.name,
        claimCount: request.body.claims.length,
        violations,
        matched:    violations.length,
      });
    },
  );

  // POST /rules/apply — apply all enabled rules to provided claims (admin)
  fastify.post<{ Body: { claims: ClaimShape[] } }>(
    '/rules/apply',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Claims'],
        summary: 'Apply all enabled rules to a set of claims',
        body: {
          type: 'object',
          required: ['claims'],
          properties: {
            claims: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        security: [{ apiKey: [] }],
      },
    },
    async (request, reply) => {
      const { violations, summary } = getRuleStore().applyAll(request.body.claims);
      return reply.send({ claimCount: request.body.claims.length, summary, violations });
    },
  );

  // GET /rules/examples — return example rule definitions (public, for docs/UI)
  fastify.get(
    '/rules/examples',
    {
      schema: {
        tags: ['Claims'],
        summary: 'Example custom rule definitions (JSON and YAML)',
        security: [],
      },
    },
    async (_request, reply) => {
      return reply.send(EXAMPLE_RULES);
    },
  );
}

const EXAMPLE_RULES = {
  description: 'Example custom rules — POST any of these to /rules to activate',
  rules: [
    {
      name:        'Revenue claim must cite source',
      description: 'Flag any claim mentioning revenue growth without a source.',
      condition:   'contains_keyword',
      params:      { keywords: ['revenue growth', 'revenue increased', 'revenue jumped'] },
      severity:    'error',
    },
    {
      name:        'Statistical claims require date',
      description: 'Require date citations for all statistical claims (percentages, billions, etc.).',
      condition:   'missing_date_citation',
      params:      {},
      severity:    'warning',
    },
    {
      name:        'Unsourced factual claims',
      description: 'Flag factual claims that have no source citations.',
      condition:   'missing_source',
      params:      {},
      severity:    'warning',
    },
    {
      name:        'Superlative language detector',
      description: 'Flag claims using absolute superlatives (best, largest, first-ever).',
      condition:   'regex_match',
      params:      { pattern: '\\b(best|largest|biggest|fastest|first.ever|world.record)\\b' },
      severity:    'info',
    },
    {
      name:        'Causal claim review',
      description: 'Flag causal claims for manual review.',
      condition:   'claim_type',
      params:      { types: ['causal', 'counterfactual'] },
      severity:    'info',
    },
  ],
};
