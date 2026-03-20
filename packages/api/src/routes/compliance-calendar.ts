import type { FastifyInstance } from 'fastify';
import { getComplianceCalendar } from '../store/compliance-calendar.js';
import { fireWebhookEvent } from '../store/webhooks.js';
import { requireApiKey, requireAdmin } from '../plugins/auth.js';

// ── JSON schemas ───────────────────────────────────────────────────────────────

const SCAN_CHECK_BODY_SCHEMA = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
  },
  additionalProperties: false,
} as const;

const DAYS_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    days: { type: 'string' },
  },
  additionalProperties: true,
} as const;

// ── Body / query interfaces ────────────────────────────────────────────────────

interface ScanCheckBody {
  claims: string[];
}

interface DeadlinesQuery {
  days?: string;
}

// ── Route plugin ───────────────────────────────────────────────────────────────

export async function complianceCalendarRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /compliance/deadlines — list upcoming regulatory deadlines
  fastify.get<{ Querystring: DeadlinesQuery }>(
    '/compliance/deadlines',
    { schema: { tags: ['Compliance'], summary: 'List upcoming regulatory deadlines with days-until countdown', querystring: DAYS_QUERY_SCHEMA } },
    async (request, reply) => {
      const calendar = getComplianceCalendar();
      const daysParam = request.query.days;
      const daysAhead = daysParam !== undefined ? parseInt(daysParam, 10) : 365;
      const deadlines = calendar.getUpcoming(isNaN(daysAhead) ? 365 : daysAhead);

      const result = deadlines.map((d) => ({
        id: d.id,
        name: d.name,
        regulation: d.regulation,
        description: d.description,
        deadline: d.deadline,
        daysUntil: calendar.getDaysUntil(d),
        severity: d.severity,
        url: d.url,
      }));

      return reply.status(200).send({ deadlines: result });
    },
  );

  // POST /compliance/scan-check — check claim texts against regulatory deadlines
  fastify.post<{ Body: ScanCheckBody }>(
    '/compliance/scan-check',
    {
      preHandler: requireApiKey,
      schema: { tags: ['Compliance'], summary: 'Check claim text against approaching regulatory deadlines', body: SCAN_CHECK_BODY_SCHEMA },
    },
    async (request, reply) => {
      const calendar = getComplianceCalendar();
      const { claims } = request.body;
      const alerts = calendar.checkClaims(claims);

      const result = alerts.map((a) => ({
        deadlineId: a.deadline.id,
        deadlineName: a.deadline.name,
        regulation: a.deadline.regulation,
        deadline: a.deadline.deadline,
        daysUntil: a.daysUntil,
        severity: a.deadline.severity,
        matchedKeywords: a.matchedKeywords,
        message: a.message,
      }));

      return reply.status(200).send({ alerts: result, total: result.length });
    },
  );

  // POST /compliance/deadlines/notify — fire webhooks for approaching deadlines
  fastify.post(
    '/compliance/deadlines/notify',
    { preHandler: requireAdmin, schema: { tags: ['Compliance'], summary: 'Fire webhook alerts for deadlines within 30/14/7 days (admin)' } },
    async (_request, reply) => {
      const calendar = getComplianceCalendar();
      const approaching = calendar.getApproaching([30, 14, 7]);

      for (const alert of approaching) {
        fireWebhookEvent('compliance.deadline_approaching', {
          deadlineId: alert.deadline.id,
          deadlineName: alert.deadline.name,
          regulation: alert.deadline.regulation,
          deadline: alert.deadline.deadline,
          daysUntil: alert.daysUntil,
          severity: alert.deadline.severity,
          message: alert.message,
        });
      }

      return reply.status(200).send({ fired: approaching.length, alerts: approaching });
    },
  );
}
