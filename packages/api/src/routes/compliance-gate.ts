import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { rateLimitScan } from '../plugins/ratelimit.js';
import { esc } from '../lib/html.js';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getScanStore } from '../store/scans.js';
import { getComplianceHistoryStore } from '../store/compliance-history.js';
import { fireWebhookEvent } from '../store/webhooks.js';
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

// ── HTML Dashboard Builder ────────────────────────────────────────────────────

interface DashboardEntry {
  projectName: string;
  scanId: string;
  complianceScore: number;
  pass: boolean;
  overallRisk: string;
  timestamp: string;
}

function buildComplianceDashboardHtml(
  history: DashboardEntry[],
  latest: { complianceScore: number; pass: boolean; overallRisk: string; projectName: string } | null,
  total: number,
  passCount: number,
  daysUntilArt50: number,
  articleStatuses: Array<{ article: string; status: string; score: number }>,
  recentScores: number[],
): string {
  const scoreColor = (s: number) => s >= 80 ? '#22c55e' : s >= 50 ? '#eab308' : '#ef4444';
  const riskColor = (r: string) => {
    const map: Record<string, string> = { Low: '#22c55e', Medium: '#eab308', High: '#f97316', Critical: '#ef4444' };
    return map[r] ?? '#6b7280';
  };
  const passRate = total > 0 ? Math.round((passCount / total) * 100) : 0;

  const rows = history.map(e => {
    const date = new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 19);
    const chip = e.pass
      ? '<span style="background:#22c55e;color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">PASS</span>'
      : '<span style="background:#ef4444;color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">FAIL</span>';
    return `<tr>
      <td style="padding:8px;border-bottom:1px solid #333">${esc(e.projectName)}</td>
      <td style="padding:8px;border-bottom:1px solid #333;text-align:center"><span style="color:${scoreColor(e.complianceScore)};font-weight:bold">${e.complianceScore}</span></td>
      <td style="padding:8px;border-bottom:1px solid #333;text-align:center">${chip}</td>
      <td style="padding:8px;border-bottom:1px solid #333;text-align:center"><span style="color:${riskColor(e.overallRisk)}">${esc(e.overallRisk)}</span></td>
      <td style="padding:8px;border-bottom:1px solid #333;color:#9ca3af">${date}</td>
    </tr>`;
  }).join('\n');

  const countdownColor = daysUntilArt50 <= 30 ? '#ef4444' : daysUntilArt50 <= 90 ? '#f97316' : '#eab308';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>EU AI Act Compliance Dashboard — Faultline</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 4px; }
    .subtitle { color: #94a3b8; margin-bottom: 24px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; text-align: center; }
    .card-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    .card-value { font-size: 32px; font-weight: 700; }
    .card-sub { font-size: 12px; color: #64748b; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
    th { padding: 12px 8px; text-align: left; background: #334155; color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; }
    .section-title { font-size: 18px; margin-bottom: 12px; color: #f8fafc; }
    .empty { text-align: center; padding: 40px; color: #64748b; }
    .countdown { display: inline-block; background: #1e293b; border: 1px solid ${countdownColor}; border-radius: 8px; padding: 4px 12px; font-size: 14px; color: ${countdownColor}; }
  </style>
</head>
<body>
  <h1>EU AI Act Compliance Dashboard</h1>
  <p class="subtitle">
    Faultline Pro — Forensic Compliance Intelligence
    &nbsp;&middot;&nbsp;
    <span class="countdown">Article 50 enforcement: ${daysUntilArt50} days</span>
  </p>

  <div class="cards">
    <div class="card">
      <div class="card-label">Latest Score</div>
      <div class="card-value" style="color:${latest ? scoreColor(latest.complianceScore) : '#64748b'}">${latest ? latest.complianceScore : '—'}</div>
      <div class="card-sub">${latest ? esc(latest.projectName) : 'No evaluations yet'}</div>
    </div>
    <div class="card">
      <div class="card-label">Status</div>
      <div class="card-value" style="color:${latest?.pass ? '#22c55e' : '#ef4444'}">${latest ? (latest.pass ? 'PASS' : 'FAIL') : '—'}</div>
      <div class="card-sub">${latest ? esc(latest.overallRisk) + ' risk' : ''}</div>
    </div>
    <div class="card">
      <div class="card-label">Pass Rate</div>
      <div class="card-value" style="color:${passRate >= 80 ? '#22c55e' : passRate >= 50 ? '#eab308' : '#ef4444'}">${passRate}%</div>
      <div class="card-sub">${passCount} of ${total} evaluations</div>
    </div>
    <div class="card">
      <div class="card-label">Countdown</div>
      <div class="card-value" style="color:${countdownColor}">${daysUntilArt50}</div>
      <div class="card-sub">days to Art. 50 enforcement</div>
    </div>
  </div>

  <h2 class="section-title" style="margin-top:32px">Score Trend</h2>
  <div style="display:flex;align-items:flex-end;gap:4px;height:60px;margin-bottom:32px;background:#1e293b;border-radius:12px;padding:16px">
    ${recentScores.length > 0 ? recentScores.map(s => {
      const h = Math.max(4, (s / 100) * 40);
      return `<div style="width:24px;height:${h}px;background:${scoreColor(s)};border-radius:4px" title="${s}"></div>`;
    }).join('') : '<span style="color:#64748b">No data</span>'}
  </div>

  ${articleStatuses.length > 0 ? `
  <h2 class="section-title">Article Compliance (Latest Scan)</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:32px">
    ${articleStatuses.map(a => {
      const color = a.status === 'compliant' ? '#22c55e' : a.status === 'partial' ? '#eab308' : a.status === 'gap' ? '#ef4444' : '#6b7280';
      const label = a.status === 'compliant' ? 'COMPLIANT' : a.status === 'partial' ? 'PARTIAL' : a.status === 'gap' ? 'GAP' : a.status.toUpperCase();
      return `<div style="background:#1e293b;border-radius:8px;padding:16px;border-left:4px solid ${color}">
        <div style="font-size:13px;color:#94a3b8;margin-bottom:4px">${esc(a.article)}</div>
        <div style="font-size:16px;font-weight:600;color:${color}">${label}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Strength: ${(a.score * 100).toFixed(0)}%</div>
      </div>`;
    }).join('')}
  </div>` : ''}

  <h2 class="section-title">Recent Evaluations</h2>
  ${history.length > 0 ? `<table>
    <thead>
      <tr>
        <th>Project</th>
        <th style="text-align:center">Score</th>
        <th style="text-align:center">Gate</th>
        <th style="text-align:center">Risk</th>
        <th>Evaluated</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>` : '<div class="empty">No compliance evaluations recorded yet. Use POST /scan/compliance-gate to evaluate.</div>'}
</body>
</html>`;
}

// ── CSV Helper ───────────────────────────────────────────────────────────────

/** Escape a value for CSV — wrap in quotes if it contains comma, quote, or newline */
function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
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

      // Record to compliance history for trend tracking
      getComplianceHistoryStore().record({
        projectName: report.projectName,
        scanId: stored.id,
        complianceScore: report.complianceScore,
        pass: gate.pass,
        overallRisk: report.overallRisk,
        nonCompliantCount: gate.nonCompliantCount,
        totalArticles: gate.totalArticles,
        threshold: gate.threshold,
      });

      // Fire webhook alert on compliance gate failure
      if (!gate.pass) {
        const failedArticles = gate.articles
          .filter(a => a.status !== 'compliant' && a.status !== 'not-applicable')
          .map(a => a.article);
        fireWebhookEvent('compliance.gate_failed', {
          scanId: stored.id,
          projectName: report.projectName,
          complianceScore: report.complianceScore,
          overallRisk: report.overallRisk,
          nonCompliantCount: gate.nonCompliantCount,
          failedArticles,
        });
      }

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

  // GET /compliance/history — query compliance history with optional filters
  fastify.get<{ Querystring: { projectName?: string; limit?: string; since?: string } }>(
    '/compliance/history',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Compliance'],
        summary: 'Query compliance gate history (time-series)',
        querystring: {
          type: 'object',
          properties: {
            projectName: { type: 'string', maxLength: 200 },
            limit: { type: 'string' },
            since: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const entries = getComplianceHistoryStore().query({
        projectName: request.query.projectName,
        limit,
        since: request.query.since,
      });
      return reply.send({ entries, count: entries.length });
    },
  );

  // GET /compliance/trend — compliance score trend for a project
  fastify.get<{ Querystring: { projectName: string } }>(
    '/compliance/trend',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Compliance'],
        summary: 'Get compliance score trend for a project',
        querystring: {
          type: 'object',
          required: ['projectName'],
          properties: {
            projectName: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const trend = getComplianceHistoryStore().trend(request.query.projectName);
      return reply.send(trend);
    },
  );

  // GET /compliance/export — export compliance history as CSV or JSON for audit trail
  fastify.get<{ Querystring: { format?: string; projectName?: string; since?: string } }>(
    '/compliance/export',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Compliance'],
        summary: 'Export compliance history for audit trail (CSV or JSON)',
        querystring: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['csv', 'json'], default: 'json' },
            projectName: { type: 'string', maxLength: 200 },
            since: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const entries = getComplianceHistoryStore().query({
        projectName: request.query.projectName,
        since: request.query.since,
        limit: 5000,  // Export up to full store capacity
      });

      if (request.query.format === 'csv') {
        const header = 'id,projectName,scanId,complianceScore,pass,overallRisk,nonCompliantCount,totalArticles,threshold,recordedAt';
        const rows = entries.map(e =>
          [e.id, csvEscape(e.projectName), e.scanId, e.complianceScore, e.pass, e.overallRisk, e.nonCompliantCount, e.totalArticles, e.threshold, e.recordedAt].join(',')
        );
        const csv = [header, ...rows].join('\n');
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename=compliance-history-${new Date().toISOString().slice(0, 10)}.csv`)
          .send(csv);
      }

      // Default: JSON
      return reply
        .header('Content-Disposition', `attachment; filename=compliance-history-${new Date().toISOString().slice(0, 10)}.json`)
        .send({ entries, count: entries.length, exportedAt: new Date().toISOString() });
    },
  );

  // GET /compliance/dashboard — HTML compliance overview
  fastify.get(
    '/compliance/dashboard',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Compliance'],
        summary: 'EU AI Act compliance dashboard (HTML)',
      },
    },
    async (_request, reply) => {
      const store = getComplianceHistoryStore();
      const history = store.query({ limit: 20 });
      const latest = history.length > 0 ? history[history.length - 1] : null;
      const all = store.query({});
      const total = all.length;
      const passCount = all.filter(e => e.pass).length;

      // Article 50 enforcement date: 2026-08-02
      const daysUntilArt50 = Math.ceil((new Date('2026-08-02').getTime() - Date.now()) / 86_400_000);

      // Map store entries (recordedAt) to DashboardEntry (timestamp) and reverse for newest-first display
      const dashboardHistory = [...history].reverse().map(e => ({
        projectName: e.projectName,
        scanId: e.scanId,
        complianceScore: e.complianceScore,
        pass: e.pass,
        overallRisk: e.overallRisk,
        timestamp: e.recordedAt,
      }));

      const latestEntry = latest
        ? {
            complianceScore: latest.complianceScore,
            pass: latest.pass,
            overallRisk: latest.overallRisk,
            projectName: latest.projectName,
          }
        : null;

      // Fetch per-article breakdown from the latest scan (if available)
      let articleStatuses: Array<{ article: string; status: string; score: number }> = [];
      if (latest) {
        const scan = getScanStore().getById(latest.scanId);
        if (scan) {
          const result = scan.result as unknown as Parameters<typeof buildEuComplianceReport>[0];
          const report = buildEuComplianceReport(result, { projectName: latest.projectName });
          articleStatuses = report.articleEvidence.map(a => ({
            article: a.article,
            status: a.status,
            score: a.strengthScore ?? 0,
          }));
        }
      }

      const recentScores = all.slice(-10).map(e => e.complianceScore);

      const html = buildComplianceDashboardHtml(dashboardHistory, latestEntry, total, passCount, daysUntilArt50, articleStatuses, recentScores);
      return reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
    },
  );
}
