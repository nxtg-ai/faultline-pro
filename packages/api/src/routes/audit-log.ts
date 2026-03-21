/**
 * Audit Log API — GET /audit/log, GET /audit/log/export
 *
 * Exposes the in-memory AuditLogger store as a queryable HTTP endpoint.
 * All routes require admin-level API key.
 *
 * GET /audit/log
 *   Query params: keyId, endpoint, method, statusCode, from, to, limit (default 100, max 1000)
 *   Returns: { entries: AuditEntry[], total: number }
 *
 * GET /audit/log/export
 *   Same filters as above; returns NDJSON stream for log archival.
 */

import type { FastifyInstance } from 'fastify';
import { getAuditLogger, type AuditEntry } from '../store/audit.js';
import { requireAdmin } from '../plugins/auth.js';

// ── Filter helper ─────────────────────────────────────────────────────────────

function filterEntries(entries: AuditEntry[], params: {
  keyId?: string;
  tenantId?: string;
  endpoint?: string;
  method?: string;
  statusCode?: string;
  from?: string;
  to?: string;
}): AuditEntry[] {
  let result = entries;

  if (params.keyId)
    result = result.filter(e => e.keyId === params.keyId);

  if (params.tenantId)
    result = result.filter(e => e.tenantId === params.tenantId);

  if (params.endpoint)
    result = result.filter(e => e.endpoint.includes(params.endpoint!));

  if (params.method)
    result = result.filter(e => e.method.toUpperCase() === params.method!.toUpperCase());

  if (params.statusCode) {
    const code = parseInt(params.statusCode, 10);
    if (!isNaN(code)) result = result.filter(e => e.statusCode === code);
  }

  if (params.from)
    result = result.filter(e => e.timestamp >= params.from!);

  if (params.to) {
    const toStr = params.to.length === 10 ? params.to + 'T23:59:59.999Z' : params.to;
    result = result.filter(e => e.timestamp <= toStr);
  }

  return result;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function auditLogRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /audit/log — query audit entries with optional filters
   *
   * Returns up to `limit` entries (default 100, max 1000), most-recent first.
   * Stats: total matches before pagination so callers can detect truncation.
   */
  fastify.get(
    '/audit/log',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const limit = Math.min(Math.max(parseInt(q.limit ?? '100', 10) || 100, 1), 1000);

      const all = getAuditLogger().getEntries().reverse(); // newest first
      const filtered = filterEntries(all, q);
      const total = filtered.length;
      const entries = filtered.slice(0, limit);

      return reply.send({ entries, total, limit, truncated: total > limit });
    },
  );

  /**
   * GET /audit/log/stats — summary statistics across all audit entries
   *
   * Returns counts by endpoint, method, statusCode, and keyId; avg latency.
   */
  fastify.get(
    '/audit/log/stats',
    { preHandler: requireAdmin },
    async (_request, reply) => {
      const entries = getAuditLogger().getEntries();
      const total = entries.length;

      const byEndpoint: Record<string, number> = {};
      const byMethod: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      const byKey: Record<string, number> = {};
      let latencySum = 0;

      for (const e of entries) {
        byEndpoint[e.endpoint] = (byEndpoint[e.endpoint] ?? 0) + 1;
        byMethod[e.method]     = (byMethod[e.method] ?? 0) + 1;
        byStatus[e.statusCode] = (byStatus[e.statusCode] ?? 0) + 1;
        byKey[e.keyId]         = (byKey[e.keyId] ?? 0) + 1;
        latencySum += e.latencyMs;
      }

      return reply.send({
        total,
        avgLatencyMs: total > 0 ? Math.round(latencySum / total) : 0,
        byEndpoint,
        byMethod,
        byStatus,
        byKey,
      });
    },
  );

  /**
   * GET /audit/log/export — download audit log as NDJSON
   *
   * Streams all matching entries as newline-delimited JSON for archival.
   */
  fastify.get(
    '/audit/log/export',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const all = getAuditLogger().getEntries().reverse();
      const filtered = filterEntries(all, q);

      const ndjson = filtered.map(e => JSON.stringify(e)).join('\n') + (filtered.length ? '\n' : '');
      const date   = new Date().toISOString().slice(0, 10);

      return reply
        .header('Content-Type', 'application/x-ndjson')
        .header('Content-Disposition', `attachment; filename="faultline-audit-${date}.ndjson"`)
        .header('X-Export-Count', String(filtered.length))
        .send(ndjson);
    },
  );
}
