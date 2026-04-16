/**
 * Art. 14 Human Sign-Off Record — POST /scans/:id/approve, GET /scans/:id/approvals
 * // Validates: N-218 (Art. 14 Human Oversight)
 *
 * Enables a named human reviewer to formally approve or reject a scan result
 * before deployment. Approval is stored with approver identity (API key),
 * tenant, UTC timestamp, and optional note.
 *
 * POST /scans/:id/approve
 *   Body: { decision?: "approved"|"rejected", note?: string }
 *   Auth: any valid API key (approver identity = requesting key)
 *   Returns: ApprovalEntry
 *
 * GET /scans/:id/approvals
 *   Auth: any valid API key
 *   Returns: { scanId, approvals: ApprovalEntry[] }
 */

import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../plugins/auth.js';
import { getApprovalStore, type ApprovalDecision } from '../store/approvals.js';
import { getTenantStore } from '../store/tenants.js';

const VALID_DECISIONS: ApprovalDecision[] = ['approved', 'rejected'];

export async function approvalsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /scans/:id/approve
   * EU AI Act Art. 14 — Human Oversight.
   * Records a human reviewer's approval or rejection of a scan result.
   */
  fastify.post(
    '/scans/:id/approve',
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { id: scanId } = request.params as { id: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const keyId = request.keyId ?? 'unknown';

      const decision: ApprovalDecision =
        typeof body.decision === 'string' && (VALID_DECISIONS as string[]).includes(body.decision)
          ? (body.decision as ApprovalDecision)
          : 'approved';

      const note = typeof body.note === 'string' ? body.note.slice(0, 500) : undefined;
      const tenantId = getTenantStore().findByKeyId(keyId)?.id;

      const entry = getApprovalStore().record({
        scanId,
        approver: keyId,
        tenantId,
        timestamp: new Date().toISOString(),
        decision,
        note,
      });

      return reply.status(201).send(entry);
    },
  );

  /**
   * GET /scans/:id/approvals
   * EU AI Act Art. 14 — retrieve all sign-off records for a scan.
   */
  fastify.get(
    '/scans/:id/approvals',
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { id: scanId } = request.params as { id: string };
      const approvals = getApprovalStore().getByScanId(scanId);
      return reply.send({ scanId, approvals, total: approvals.length });
    },
  );
}
