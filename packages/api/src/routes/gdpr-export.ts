/**
 * N-120 — GDPR export endpoint
 *
 * GET /tenants/:id/export
 *
 * Returns a ZIP archive containing all data held for a tenant:
 *   - manifest.json        — export metadata
 *   - scan-history.json    — all scan entries for the tenant
 *   - audit-log.ndjson     — audit log entries (NDJSON, one JSON object per line)
 *   - notifications.json   — notification history for the tenant
 *   - webhooks.json        — webhooks registered by the tenant
 *   - usage.json           — usage meter data for all keys in the tenant
 *   - costs.json           — provider cost estimates for the tenant (N-123)
 */
import type { FastifyInstance } from 'fastify';
import AdmZip from 'adm-zip';
import { requireAdmin } from '../plugins/auth.js';
import { getTenantStore } from '../store/tenants.js';
import { getScanHistory } from '../store/scan-history.js';
import { getAuditLogger } from '../store/audit.js';
import { getNotificationStore } from '../store/notifications.js';
import { getWebhookStore } from '../store/webhooks.js';
import { getUsageMeter } from '../store/usage.js';
import { getCostStore } from '../store/costs.js';

export async function gdprExportRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/tenants/:id/export',
    {
      preHandler: requireAdmin,
      schema: {
        tags: ['Tenants'],
        summary: 'GDPR data export — download all data held for a tenant as a ZIP',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id: tenantId } = request.params as { id: string };

      // 404 when tenant does not exist
      const tenant = getTenantStore().get(tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      const exportedAt = new Date().toISOString();
      const dateSlug = exportedAt.split('T')[0]; // YYYY-MM-DD

      // ── Collect tenant data ─────────────────────────────────────────────────

      const scanEntries = getScanHistory()
        .getRecent(10_000)
        .filter((e) => e.tenantId === tenantId);

      const auditEntries = getAuditLogger()
        .getEntries()
        .filter((e) => e.tenantId === tenantId);

      const notifications = getNotificationStore().getHistory(undefined, 10_000, tenantId);

      const webhooks = getWebhookStore().list(tenantId);

      // Collect usage for every API key that belongs to this tenant
      const usageByKey: Record<string, Record<string, number>> = {};
      for (const keyId of tenant.keyIds ?? []) {
        usageByKey[keyId] = getUsageMeter().getUsage(keyId);
      }

      const costs = getCostStore().getCosts({ tenantId });

      // ── Build ZIP ───────────────────────────────────────────────────────────

      const zip = new AdmZip();

      const manifest = {
        exportedAt,
        tenantId,
        tenantName: tenant.name,
        counts: {
          scanEntries: scanEntries.length,
          auditEntries: auditEntries.length,
          notifications: notifications.length,
          webhooks: webhooks.length,
          costs: costs.length,
          keyIds: (tenant.keyIds ?? []).length,
        },
      };

      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
      zip.addFile('scan-history.json', Buffer.from(JSON.stringify(scanEntries, null, 2)));
      zip.addFile(
        'audit-log.ndjson',
        Buffer.from(auditEntries.map((e) => JSON.stringify(e)).join('\n')),
      );
      zip.addFile('notifications.json', Buffer.from(JSON.stringify(notifications, null, 2)));
      zip.addFile('webhooks.json', Buffer.from(JSON.stringify(webhooks, null, 2)));
      zip.addFile('usage.json', Buffer.from(JSON.stringify(usageByKey, null, 2)));
      zip.addFile('costs.json', Buffer.from(JSON.stringify(costs, null, 2)));

      const zipBuffer = zip.toBuffer();
      const filename = `faultline-gdpr-export-${tenantId}-${dateSlug}.zip`;

      reply
        .code(200)
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(zipBuffer);
    },
  );
}
