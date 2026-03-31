import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getScanStore } from '../store/scans.js';
import {
  buildEuComplianceReport,
  evaluateComplianceGate,
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
  },
  additionalProperties: false,
} as const;

interface ComplianceGateBody {
  text: string;
  provider?: 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';
  projectName?: string;
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
      const { text, provider, projectName } = request.body;
      const keyId = request.keyId ?? 'unknown';

      const result = await scan(text, provider);
      const stored = getScanStore().record(keyId, text, result as unknown as Record<string, unknown>);
      const report = buildEuComplianceReport(result, { projectName });
      const gate = evaluateComplianceGate(report);

      const response: ComplianceGateResponse = { gate, report, scanId: stored.id };
      return reply.status(gate.pass ? 200 : 422).send(response);
    },
  );

  // GET /scan/:id/compliance — evaluate compliance for an existing scan
  fastify.get<{ Params: { id: string }; Querystring: { projectName?: string } }>(
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
          properties: { projectName: { type: 'string', maxLength: 200 } },
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

      return reply.status(gate.pass ? 200 : 422).send({ gate, report, scanId: stored.id });
    },
  );
}
