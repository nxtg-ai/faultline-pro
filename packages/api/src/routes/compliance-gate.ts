import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getScanStore } from '../store/scans.js';
import {
  buildEuComplianceReport,
  evaluateComplianceGate,
  diffComplianceReports,
  renderComplianceBadgeSvg,
  type EuAiActComplianceReport,
  type CiGateResult,
} from '@nxtg/faultline/cli/compliance-report.js';

// ── Request/Response Schemas ─────────────────────────────────────────────────

const POST_BODY_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 50_000 },
    provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
    projectName: { type: 'string', maxLength: 200 },
    threshold: { type: 'number', minimum: 0, maximum: 100 },
    strict: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

interface ComplianceGateBody {
  text: string;
  provider?: 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';
  projectName?: string;
  threshold?: number;
  strict?: boolean;
}

interface ComplianceGateResponse {
  gate: CiGateResult;
  report: EuAiActComplianceReport;
  scanId: string;
}

// ── Route Registration ──────────────────────────────────────────────────────

export async function complianceGateRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /scan/compliance-gate — scan text and evaluate EU AI Act compliance
  fastify.post<{ Body: ComplianceGateBody }>(
    '/scan/compliance-gate',
    {
      preHandler: [requireApiKey, rateLimitScan],
      schema: {
        tags: ['Compliance'],
        summary: 'Scan text and evaluate EU AI Act compliance gate (pass/fail)',
        description:
          'Scans the provided text, generates an EU AI Act compliance report, and evaluates ' +
          'a pass/fail gate. Fails if any article is non-compliant or overall risk is high/critical.',
        body: POST_BODY_SCHEMA,
      },
    },
    async (request, reply) => {
      const { text, provider, projectName, threshold, strict } = request.body;
      const keyId = request.keyId ?? 'unknown';

      const result = await scan(text, provider);
      const stored = getScanStore().record(keyId, text, result as unknown as Record<string, unknown>);
      const report = buildEuComplianceReport(result, { projectName });
      const gate = evaluateComplianceGate(report, { threshold, strict });

      const response: ComplianceGateResponse = { gate, report, scanId: stored.id };
      return reply.status(gate.pass ? 200 : 422).send(response);
    },
  );

  // GET /scan/:id/compliance — evaluate compliance for an existing scan
  fastify.get<{ Params: { id: string }; Querystring: { projectName?: string; threshold?: string; strict?: string } }>(
    '/scan/:id/compliance',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Compliance'],
        summary: 'Evaluate EU AI Act compliance for an existing scan result',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: {
            projectName: { type: 'string', maxLength: 200 },
            threshold: { type: 'string' },
            strict: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const stored = getScanStore().getById(request.params.id);
      if (!stored) {
        return reply.status(404).send({ error: 'Scan not found.' });
      }

      const result = stored.result as unknown as Parameters<typeof buildEuComplianceReport>[0];
      const report = buildEuComplianceReport(result, { projectName: request.query.projectName });
      const threshold = request.query.threshold ? parseInt(request.query.threshold, 10) : undefined;
      const strict = request.query.strict === 'true';
      const gate = evaluateComplianceGate(report, { threshold, strict });

      return reply.status(gate.pass ? 200 : 422).send({ gate, report, scanId: stored.id });
    },
  );

  // POST /scan/compliance-diff — compare compliance of two scan IDs
  fastify.post<{ Body: { beforeId: string; afterId: string; projectName?: string } }>(
    '/scan/compliance-diff',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Compliance'],
        summary: 'Compare EU AI Act compliance between two scans',
        body: {
          type: 'object',
          required: ['beforeId', 'afterId'],
          properties: {
            beforeId: { type: 'string' },
            afterId: { type: 'string' },
            projectName: { type: 'string', maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { beforeId, afterId, projectName } = request.body;
      const beforeScan = getScanStore().getById(beforeId);
      if (!beforeScan) return reply.status(404).send({ error: `Scan not found: ${beforeId}` });
      const afterScan = getScanStore().getById(afterId);
      if (!afterScan) return reply.status(404).send({ error: `Scan not found: ${afterId}` });

      const beforeResult = beforeScan.result as unknown as Parameters<typeof buildEuComplianceReport>[0];
      const afterResult = afterScan.result as unknown as Parameters<typeof buildEuComplianceReport>[0];
      const beforeReport = buildEuComplianceReport(beforeResult, { projectName });
      const afterReport = buildEuComplianceReport(afterResult, { projectName });
      const diff = diffComplianceReports(beforeReport, afterReport);

      return reply.send(diff);
    },
  );

  // GET /scan/:id/compliance/badge — SVG compliance badge for embedding in READMEs
  fastify.get<{ Params: { id: string }; Querystring: { label?: string; projectName?: string } }>(
    '/scan/:id/compliance/badge',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Compliance'],
        summary: 'Generate an SVG compliance badge for a scan result',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        querystring: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: 50 },
            projectName: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const stored = getScanStore().getById(request.params.id);
      if (!stored) {
        return reply.status(404).send({ error: 'Scan not found.' });
      }

      const result = stored.result as unknown as Parameters<typeof buildEuComplianceReport>[0];
      const report = buildEuComplianceReport(result, { projectName: request.query.projectName });
      const gate = evaluateComplianceGate(report);
      const svg = renderComplianceBadgeSvg(report.complianceScore, gate.pass, {
        label: request.query.label,
      });

      return reply
        .header('Content-Type', 'image/svg+xml')
        .header('Cache-Control', 'no-cache, no-store, must-revalidate')
        .send(svg);
    },
  );
}
