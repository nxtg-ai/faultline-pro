/**
 * N-121 — GDPR erasure endpoint tests (ER1–ER15)
 *
 * Validates DELETE /tenants/:id/data (GDPR Article 17 — Right to Erasure):
 *   - Returns 200 with deleted-record counts
 *   - All five data categories erased: scans, audit, notifications, webhooks, usage
 *   - Tenant itself is NOT deleted (only its data)
 *   - Other tenants' data is NOT touched (isolation)
 *   - Idempotent: second call returns all-zero counts
 *   - 404 for unknown tenant
 *   - 403 without admin credentials
 *   - After erasure, export ZIP is empty
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetTenantStore, getTenantStore } from '../src/store/tenants.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetScanHistory, getScanHistory } from '../src/store/scan-history.js';
import { resetAuditLogger, getAuditLogger } from '../src/store/audit.js';
import { resetNotificationStore, getNotificationStore } from '../src/store/notifications.js';
import { resetWebhookStore, getWebhookStore } from '../src/store/webhooks.js';
import { resetUsageMeter, getUsageMeter } from '../src/store/usage.js';
import type { FastifyInstance } from 'fastify';

// ── Helpers ───────────────────────────────────────────────────────────────────

function adminHeaders() {
  return { 'x-api-key': 'admin-test-key' };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

describe('GDPR erasure endpoint (ER1–ER15)', () => {
  let server: FastifyInstance;
  let tenantId: string;
  let keyId: string;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-test-key';
    resetTenantStore();
    resetKeyStore();
    resetScanHistory();
    resetAuditLogger();
    resetNotificationStore();
    resetWebhookStore();
    resetUsageMeter();

    const key = getKeyStore().create('erasure-test-key', ['scan'], 'erasure-key');
    keyId = key.id;
    const tenant = getTenantStore().create('Erasure Test Corp', [keyId]);
    tenantId = tenant.id;

    // Seed all five data categories
    getScanHistory().record({
      keyId, tenantId, provider: 'mock', overallRisk: 'Low',
      textHash: 'hash1', textPreview: 'claim text', claimCount: 2, latencyMs: 50,
      timestamp: new Date().toISOString(),
    });

    getAuditLogger().log({
      keyId, tenantId, endpoint: '/scan', method: 'POST',
      statusCode: 200, latencyMs: 100, timestamp: new Date().toISOString(),
    });

    getNotificationStore().setPrefs(keyId, ['scan.failed'], null, null);
    await getNotificationStore().dispatch('scan.failed', { error: 'test' }, keyId);

    getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret', tenantId);

    getUsageMeter().increment(keyId);
    getUsageMeter().increment(keyId);

    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  // ── ER1: returns 200 ──────────────────────────────────────────────────────

  it('ER1: returns 200 for a known tenant', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
  });

  // ── ER2: response body contains tenantId ─────────────────────────────────

  it('ER2: response includes tenantId', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const body = JSON.parse(res.body);
    expect(body.tenantId).toBe(tenantId);
  });

  // ── ER3: deleted.scanEntries is 1 ─────────────────────────────────────────

  it('ER3: response reports 1 deleted scan entry', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res.body);
    expect(deleted.scanEntries).toBe(1);
  });

  // ── ER4: deleted.auditEntries is 1 ───────────────────────────────────────

  it('ER4: response reports 1 deleted audit entry', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res.body);
    expect(deleted.auditEntries).toBe(1);
  });

  // ── ER5: deleted.notifications is 1 ──────────────────────────────────────

  it('ER5: response reports 1 deleted notification', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res.body);
    expect(deleted.notifications).toBe(1);
  });

  // ── ER6: deleted.webhooks is 1 ───────────────────────────────────────────

  it('ER6: response reports 1 deleted webhook', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res.body);
    expect(deleted.webhooks).toBe(1);
  });

  // ── ER7: deleted.usageKeys is 1 ──────────────────────────────────────────

  it('ER7: response reports 1 deleted usage key', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res.body);
    expect(deleted.usageKeys).toBe(1);
  });

  // ── ER8: scan history actually erased ─────────────────────────────────────

  it('ER8: scan history is empty after erasure', async () => {
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const remaining = getScanHistory().getRecent(100).filter((e) => e.tenantId === tenantId);
    expect(remaining).toHaveLength(0);
  });

  // ── ER9: audit log actually erased ───────────────────────────────────────

  it('ER9: audit log is empty after erasure', async () => {
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const remaining = getAuditLogger().getEntries().filter((e) => e.tenantId === tenantId);
    expect(remaining).toHaveLength(0);
  });

  // ── ER10: tenant record itself still exists ───────────────────────────────

  it('ER10: tenant record itself is not deleted — only its data', async () => {
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    expect(getTenantStore().get(tenantId)).toMatchObject({ id: tenantId });
  });

  // ── ER11: idempotent — second call returns all-zero counts ────────────────

  it('ER11: second erasure call is idempotent (returns zero counts)', async () => {
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const res2 = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const { deleted } = JSON.parse(res2.body);
    expect(deleted.scanEntries).toBe(0);
    expect(deleted.auditEntries).toBe(0);
    expect(deleted.notifications).toBe(0);
    expect(deleted.webhooks).toBe(0);
  });

  // ── ER12: 404 for unknown tenant ─────────────────────────────────────────

  it('ER12: returns 404 for unknown tenant', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/tenants/no-such-tenant/data', headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
  });

  // ── ER13: 403 without admin credentials ──────────────────────────────────

  it('ER13: returns 403 without admin credentials', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data` });
    expect(res.statusCode).toBe(403);
  });

  // ── ER14: tenant isolation — other tenant's data untouched ────────────────

  it('ER14: erasing tenant A does not affect tenant B data', async () => {
    // Create a second tenant with its own scan
    const key2 = getKeyStore().create('other-key', ['scan'], 'other-key');
    const tenant2 = getTenantStore().create('Other Corp', [key2.id]);
    getScanHistory().record({
      keyId: key2.id, tenantId: tenant2.id, provider: 'mock', overallRisk: 'Low',
      textHash: 'hash-other', textPreview: 'other claim', claimCount: 1, latencyMs: 40,
      timestamp: new Date().toISOString(),
    });
    getAuditLogger().log({
      keyId: key2.id, tenantId: tenant2.id, endpoint: '/scan', method: 'POST',
      statusCode: 200, latencyMs: 80, timestamp: new Date().toISOString(),
    });

    // Erase tenant 1
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });

    // Tenant 2 data should be intact
    const scans2 = getScanHistory().getRecent(100).filter((e) => e.tenantId === tenant2.id);
    expect(scans2).toHaveLength(1);
    const audit2 = getAuditLogger().getEntries().filter((e) => e.tenantId === tenant2.id);
    expect(audit2).toHaveLength(1);
  });

  // ── ER15: export after erasure returns empty ZIP ──────────────────────────

  it('ER15: GDPR export after erasure returns ZIP with zero manifest counts', async () => {
    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    // Parse manifest from ZIP to confirm zero counts
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(res.rawPayload);
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf-8'));
    expect(manifest.counts.scanEntries).toBe(0);
    expect(manifest.counts.auditEntries).toBe(0);
    expect(manifest.counts.notifications).toBe(0);
    expect(manifest.counts.webhooks).toBe(0);
  });
});
