/**
 * POST /export — Download scan history as CSV, JSON, or NDJSON.
 *
 * Exports from the in-memory ScanHistoryStore (up to the last 1,000 scans).
 * Supports date-range, provider, and risk-level filtering.
 *
 * Response: file download with Content-Disposition attachment header.
 */

import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getScanHistory } from '../store/scan-history.js';
import type { ScanEntry } from '../store/scan-history.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type ExportFormat = 'csv' | 'json' | 'ndjson';

interface ExportBody {
  format?: ExportFormat;
  from?: string;
  to?: string;
  provider?: string;
  risk?: string;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  'id',
  'timestamp',
  'provider',
  'overall_risk',
  'claim_count',
  'latency_ms',
  'text_preview',
  'key_id',
  'trust_score',
] as const;

function csvEscape(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(fields: unknown[]): string {
  return fields.map(csvEscape).join(',');
}

// Derive a 0–100 trust score from risk level (inverse of risk)
const RISK_TRUST: Record<string, number> = {
  low: 90,
  medium: 65,
  high: 35,
  critical: 10,
};

function trustScore(entry: ScanEntry): number {
  return RISK_TRUST[entry.overallRisk] ?? 50;
}

// ── Format renderers ──────────────────────────────────────────────────────────

function renderCsv(entries: ScanEntry[]): string {
  const rows: string[] = [csvRow([...CSV_HEADERS])];
  for (const e of entries) {
    rows.push(csvRow([
      e.id,
      e.timestamp,
      e.provider,
      e.overallRisk,
      e.claimCount,
      e.latencyMs,
      e.textPreview,
      e.keyId,
      trustScore(e),
    ]));
  }
  return rows.join('\n') + '\n';
}

function renderJson(entries: ScanEntry[]): string {
  return JSON.stringify(
    entries.map(e => ({ ...e, trustScore: trustScore(e) })),
    null,
    2,
  ) + '\n';
}

function renderNdjson(entries: ScanEntry[]): string {
  return entries.map(e => JSON.stringify({ ...e, trustScore: trustScore(e) })).join('\n') + '\n';
}

function mimeType(format: ExportFormat): string {
  switch (format) {
    case 'csv':    return 'text/csv';
    case 'ndjson': return 'application/x-ndjson';
    default:       return 'application/json';
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

const BODY_SCHEMA = {
  type: 'object',
  properties: {
    format:   { type: 'string', enum: ['csv', 'json', 'ndjson'] },
    from:     { type: 'string', description: 'ISO 8601 start date (inclusive)' },
    to:       { type: 'string', description: 'ISO 8601 end date (inclusive)' },
    provider: { type: 'string', enum: ['gemini', 'openai', 'claude', 'perplexity', 'mock'] },
    risk:     { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
  },
  additionalProperties: false,
} as const;

export async function exportRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ExportBody }>(
    '/export',
    {
      preHandler: [requireApiKey],
      schema: {
        tags: ['Scans'],
        summary: 'Export scan history as CSV, JSON, or NDJSON',
        body: BODY_SCHEMA,
      },
    },
    async (request, reply) => {
      const {
        format = 'csv',
        from,
        to,
        provider,
        risk,
      } = request.body ?? {};

      if (!['csv', 'json', 'ndjson'].includes(format)) {
        return reply.status(400).send({ error: 'format must be csv, json, or ndjson' });
      }

      // Fetch all entries matching filters using the existing search() method
      const toStr = to && to.length === 10 ? to + 'T23:59:59.999Z' : to;
      const { entries } = getScanHistory().search({
        from,
        to: toStr,
        provider,
        risk,
        limit: 1000,
      });

      if (entries.length === 0) {
        return reply.status(200).send({ message: 'No scan history matched the given filters.', count: 0 });
      }

      let body: string;
      switch (format as ExportFormat) {
        case 'csv':    body = renderCsv(entries);    break;
        case 'ndjson': body = renderNdjson(entries); break;
        default:       body = renderJson(entries);   break;
      }

      const ext = format === 'ndjson' ? 'ndjson' : format;
      const filename = `faultline-export-${new Date().toISOString().slice(0, 10)}.${ext}`;

      reply
        .header('Content-Type', mimeType(format as ExportFormat))
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('X-Export-Count', String(entries.length));

      return reply.status(200).send(body);
    },
  );
}
