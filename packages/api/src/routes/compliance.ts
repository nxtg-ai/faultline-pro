import type { FastifyInstance } from 'fastify';
import { getComplianceTemplateStore } from '../store/compliance-templates.js';
import { requireApiKey, requireAdmin } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { scan } from '@nxtg/faultline/cli/scan.js';

type Provider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

// ── JSON schemas ──────────────────────────────────────────────────────────────

const SCAN_BODY_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 50000 },
    provider: {
      type: 'string',
      enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'],
    },
  },
  additionalProperties: false,
} as const;

const TEMPLATE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['template'],
  properties: { template: { type: 'string' } },
} as const;

const CUSTOM_TEMPLATE_BODY_SCHEMA = {
  type: 'object',
  required: ['name', 'industry', 'regulations', 'rules', 'riskThresholds'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    industry: { type: 'string', minLength: 1, maxLength: 100 },
    regulations: { type: 'array', items: { type: 'string' }, minItems: 1 },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'description', 'claimPatterns', 'severity'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          claimPatterns: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        },
        additionalProperties: false,
      },
      minItems: 1,
    },
    riskThresholds: {
      type: 'object',
      required: ['critical', 'high', 'medium'],
      properties: {
        critical: { type: 'number', minimum: 1 },
        high: { type: 'number', minimum: 1 },
        medium: { type: 'number', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

// ── Body / param interfaces ───────────────────────────────────────────────────

interface ScanComplianceBody {
  text: string;
  provider?: Provider;
}

interface ScanComplianceParams {
  template: string;
}

interface CustomTemplateBody {
  name: string;
  industry: string;
  regulations: string[];
  rules: Array<{
    id: string;
    name: string;
    description: string;
    claimPatterns: string[];
    severity: 'critical' | 'high' | 'medium' | 'low';
  }>;
  riskThresholds: { critical: number; high: number; medium: number };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function complianceRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /templates/compliance — list all compliance templates (no auth)
  fastify.get('/templates/compliance', async (_request, reply) => {
    return reply.status(200).send(getComplianceTemplateStore().list());
  });

  // POST /templates/compliance — upload custom template (admin only)
  fastify.post<{ Body: CustomTemplateBody }>(
    '/templates/compliance',
    {
      preHandler: requireAdmin,
      schema: { body: CUSTOM_TEMPLATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const { name, industry, regulations, rules, riskThresholds } = request.body;
      const template = getComplianceTemplateStore().addCustom({
        name,
        industry,
        regulations,
        rules,
        riskThresholds,
      });
      return reply.status(201).send(template);
    },
  );

  // DELETE /templates/compliance/:id — delete custom template (admin only)
  fastify.delete<{ Params: { id: string } }>(
    '/templates/compliance/:id',
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const store = getComplianceTemplateStore();
      const existing = store.get(request.params.id);

      if (!existing) {
        return reply.status(404).send({ error: 'Compliance template not found.' });
      }

      if (!existing.custom) {
        return reply.status(400).send({ error: 'Cannot delete built-in compliance templates.' });
      }

      store.deleteCustom(request.params.id);
      return reply.status(204).send();
    },
  );

  // POST /scan/compliance/:template — scan + apply compliance template
  fastify.post<{ Params: ScanComplianceParams; Body: ScanComplianceBody }>(
    '/scan/compliance/:template',
    {
      preHandler: [requireApiKey, rateLimitScan],
      schema: {
        params: TEMPLATE_PARAMS_SCHEMA,
        body: SCAN_BODY_SCHEMA,
      },
    },
    async (request, reply) => {
      const store = getComplianceTemplateStore();
      const template = store.get(request.params.template);

      if (!template) {
        return reply.status(404).send({ error: 'Compliance template not found.' });
      }

      const { text, provider } = request.body;

      try {
        const scanResult = await scan(text, provider);
        const complianceAnalysis = store.applyTemplate(
          template,
          scanResult.claims,
          scanResult.verifications,
        );
        return reply.status(200).send({ ...scanResult, complianceAnalysis });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );
}
