/**
 * Art. 9 Risk Register Export — POST /scan/risk-register
 * // Validates: N-217 (Art. 9 Risk Register)
 *
 * Aggregates scan history into a versioned, structured risk register document
 * mapped to Art. 9 lifecycle phases: development / testing / deployment / monitoring.
 *
 * Request body (all optional):
 *   { phase?: "development"|"testing"|"deployment"|"monitoring",
 *     from?: ISO date string, to?: ISO date string,
 *     tenantId?: string, limit?: number (default 100) }
 *
 * Response: versioned JSON risk register document.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../plugins/auth.js';
import { getScanHistory } from '../store/scan-history.js';

export type LifecyclePhase = 'development' | 'testing' | 'deployment' | 'monitoring';
const VALID_PHASES: LifecyclePhase[] = ['development', 'testing', 'deployment', 'monitoring'];

export async function riskRegisterRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /scan/risk-register
   * EU AI Act Art. 9 — Risk Management System.
   * Returns a versioned risk register aggregating scan findings by lifecycle phase.
   */
  fastify.post(
    '/scan/risk-register',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;

      const phase: LifecyclePhase =
        typeof body.phase === 'string' && (VALID_PHASES as string[]).includes(body.phase)
          ? (body.phase as LifecyclePhase)
          : 'monitoring';

      const from = typeof body.from === 'string' ? body.from : undefined;
      const to = typeof body.to === 'string' ? body.to : undefined;
      const tenantId = typeof body.tenantId === 'string' ? body.tenantId : undefined;
      const limit = typeof body.limit === 'number' ? Math.min(Math.max(body.limit, 1), 500) : 100;

      const { entries } = getScanHistory().search({ from, to, tenantId, limit });

      const riskCounts = { low: 0, medium: 0, high: 0, critical: 0 };
      for (const e of entries) {
        const r = e.overallRisk as keyof typeof riskCounts;
        if (r in riskCounts) riskCounts[r]++;
      }

      const findings = entries.map(e => ({
        scanId: e.id,
        timestamp: e.timestamp,
        textPreview: e.textPreview,
        overallRisk: e.overallRisk,
        claimCount: e.claimCount,
        provider: e.provider,
        keyId: e.keyId,
        tenantId: e.tenantId,
        lifecyclePhase: phase,
        article: 'Art. 9 — Risk Management System',
      }));

      const register = {
        version: randomUUID(),
        generatedAt: new Date().toISOString(),
        article: 'Art. 9 — Risk Management System (EU AI Act)',
        lifecyclePhase: phase,
        summary: {
          totalScans: entries.length,
          riskDistribution: riskCounts,
          highRiskCount: riskCounts.high,
          criticalRiskCount: riskCounts.critical,
          dateRange: { from: from ?? null, to: to ?? null },
        },
        findings,
      };

      return reply.send(register);
    },
  );
}
