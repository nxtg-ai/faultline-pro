/**
 * N-120 — GDPR export endpoint tests (GE1–GE15)
 *
 * Validates GET /tenants/:id/export:
 *   - ZIP archive returned with correct content-type and filename
 *   - All six files present in the archive
 *   - manifest.json counts match the actual data seeded
 *   - Tenant isolation: only data belonging to the requested tenant is included
 *   - 404 for unknown tenants
 *   - 401 for requests without admin credentials
 *   - Empty tenant still returns a valid ZIP
 *   - Audit log NDJSON format
 *   - Usage data scoped to tenant's keys
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import { buildServer } from '../src/server.js';
import { resetTenantStore, getTenantStore } from '../src/store/tenants.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetScanHistory, getScanHistory } from '../src/store/scan-history.js';
import { resetAuditLogger, getAuditLogger } from '../src/store/audit.js';
import { resetNotificationStore, getNotificationStore } from '../src/store/notifications.js';
import { resetWebhookStore, getWebhookStore } from '../src/store/webhooks.js';
import { resetUsageMeter, getUsageMeter } from '../src/store/usage.js';
import type { FastifyInstance } from 'fastify';

// ── Helper ────────────────────────────────────────────────────────────────────

function adminHeaders() {
  return { 'x-api-key': 'admin-test-key' };
}

function parseZip(body: Buffer): AdmZip {
  return new AdmZip(body);
}

function zipEntry(zip: AdmZip, name: string): string {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`ZIP entry not found: ${name}`);
  return entry.getData().toString('utf-8');
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

describe('GDPR export endpoint (GE1–GE15)', () => {
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

    // Create a key + tenant
    const key = getKeyStore().create('export-test-key', ['scan'], 'tenant-key');
    keyId = key.id;
    const tenant = getTenantStore().create('GDPR Test Corp', [keyId]);
    tenantId = tenant.id;

    // Seed scan history
    getScanHistory().record({
      keyId, tenantId, provider: 'mock', overallRisk: 'High',
      textHash: 'abc123', textPreview: 'First claim text', claimCount: 3, latencyMs: 100,
      timestamp: new Date().toISOString(),
    });
    getScanHistory().record({
      keyId, tenantId, provider: 'mock', overallRisk: 'Low',
      textHash: 'def456', textPreview: 'Second claim text', claimCount: 5, latencyMs: 80,
      timestamp: new Date().toISOString(),
    });

    // Seed audit log
    getAuditLogger().log({ keyId, tenantId, endpoint: '/scan', method: 'POST', statusCode: 200, latencyMs: 120, timestamp: new Date().toISOString() });

    // Seed notifications via prefs + dispatch
    getNotificationStore().setPrefs(keyId, ['scan.failed'], null, null);
    await getNotificationStore().dispatch('scan.failed', { result: 'ok' }, keyId);

    // Seed webhook
    getWebhookStore().create('https://example.com/hook', ['scan.failed'], 'secret123', tenantId);

    // Seed usage
    getUsageMeter().increment(keyId);
    getUsageMeter().increment(keyId);

    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  // ── GE1: happy path — returns 200 ─────────────────────────────────────────

  it('GE1: returns 200 for a known tenant', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
  });

  // ── GE2: content-type is application/zip ──────────────────────────────────

  it('GE2: Content-Type is application/zip', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    expect(res.headers['content-type']).toMatch(/application\/zip/);
  });

  // ── GE3: Content-Disposition contains tenant ID and .zip ──────────────────

  it('GE3: Content-Disposition filename contains tenantId and .zip extension', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const disposition = res.headers['content-disposition'] as string;
    expect(disposition).toContain(tenantId);
    expect(disposition).toContain('.zip');
  });

  // ── GE4: ZIP contains manifest.json ───────────────────────────────────────

  it('GE4: ZIP archive contains manifest.json', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = parseZip(res.rawPayload);
    expect(zip.getEntry('manifest.json')).not.toBeNull();
  });

  // ── GE5: ZIP contains all six expected files ───────────────────────────────

  it('GE5: ZIP contains all six expected files', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = parseZip(res.rawPayload);
    const names = zip.getEntries().map((e) => e.entryName);
    for (const expected of ['manifest.json', 'scan-history.json', 'audit-log.ndjson', 'notifications.json', 'webhooks.json', 'usage.json']) {
      expect(names, `missing ${expected}`).toContain(expected);
    }
  });

  // ── GE6: manifest counts match seeded data ────────────────────────────────

  it('GE6: manifest.json counts match seeded data', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = parseZip(res.rawPayload);
    const manifest = JSON.parse(zipEntry(zip, 'manifest.json'));
    expect(manifest.counts.scanEntries).toBe(2);
    expect(manifest.counts.auditEntries).toBe(1);
    expect(manifest.counts.notifications).toBe(1);
    expect(manifest.counts.webhooks).toBe(1);
    expect(manifest.tenantId).toBe(tenantId);
  });

  // ── GE7: scan-history.json is non-empty and contains seeded entries ────────

  it('GE7: scan-history.json contains non-empty seeded scan entries', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = parseZip(res.rawPayload);
    const scans = JSON.parse(zipEntry(zip, 'scan-history.json'));
    expect(Array.isArray(scans)).toBe(true);
    expect(scans.length).toBe(2);
    expect(scans[0].tenantId).toBe(tenantId);
  });

  // ── GE8: audit-log.ndjson is valid NDJSON ─────────────────────────────────

  it('GE8: audit-log.ndjson is valid NDJSON with one entry per line', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = parseZip(res.rawPayload);
    const ndjson = zipEntry(zip, 'audit-log.ndjson');
    const lines = ndjson.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.tenantId).toBe(tenantId);
    expect(parsed.endpoint).toBe('/scan');
  });

  // ── GE9: notifications.json has seeded notification ───────────────────────

  it('GE9: notifications.json contains the seeded notification', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = parseZip(res.rawPayload);
    const notifications = JSON.parse(zipEntry(zip, 'notifications.json'));
    expect(Array.isArray(notifications)).toBe(true);
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    expect(notifications[0].eventType).toBe('scan.failed');
  });

  // ── GE10: webhooks.json has seeded webhook ────────────────────────────────

  it('GE10: webhooks.json contains the seeded webhook', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = parseZip(res.rawPayload);
    const webhooks = JSON.parse(zipEntry(zip, 'webhooks.json'));
    expect(Array.isArray(webhooks)).toBe(true);
    expect(webhooks.length).toBe(1);
    expect(webhooks[0].url).toBe('https://example.com/hook');
  });

  // ── GE11: usage.json contains key usage ───────────────────────────────────

  it('GE11: usage.json contains usage data for the tenant key', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = parseZip(res.rawPayload);
    const usage = JSON.parse(zipEntry(zip, 'usage.json'));
    expect(usage[keyId]).toBeDefined();
    const total = Object.values(usage[keyId] as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(2);
  });

  // ── GE12: 404 for unknown tenant ──────────────────────────────────────────

  it('GE12: returns 404 for an unknown tenant ID', async () => {
    const res = await server.inject({ method: 'GET', url: '/tenants/no-such-tenant/export', headers: adminHeaders() });
    expect(res.statusCode).toBe(404);
  });

  // ── GE13: 403 without admin credentials ───────────────────────────────────

  it('GE13: returns 403 without admin credentials', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export` });
    expect(res.statusCode).toBe(403);
  });

  // ── GE14: tenant isolation — other tenant's data not included ─────────────

  it('GE14: scan-history.json contains only the requested tenants scans', async () => {
    // Create a second tenant + key with its own scan
    const key2 = getKeyStore().create('other-key', ['scan'], 'other-key');
    const tenant2 = getTenantStore().create('Other Corp', [key2.id]);
    getScanHistory().record({
      keyId: key2.id, tenantId: tenant2.id, provider: 'mock', overallRisk: 'Low',
      textHash: 'zzz999', textPreview: 'Other corp claim', claimCount: 1, latencyMs: 50,
      timestamp: new Date().toISOString(),
    });

    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = parseZip(res.rawPayload);
    const scans = JSON.parse(zipEntry(zip, 'scan-history.json'));
    // Should still be exactly 2 — no bleed from tenant2
    expect(scans.length).toBe(2);
    expect(scans.every((s: { tenantId: string }) => s.tenantId === tenantId)).toBe(true);
  });

  // ── GE15: empty tenant returns valid ZIP with zero-count manifest ──────────

  it('GE15: empty tenant returns a valid ZIP with zero counts', async () => {
    const emptyTenant = getTenantStore().create('Empty Corp');
    const res = await server.inject({ method: 'GET', url: `/tenants/${emptyTenant.id}/export`, headers: adminHeaders() });
    expect(res.statusCode).toBe(200);
    const zip = parseZip(res.rawPayload);
    const manifest = JSON.parse(zipEntry(zip, 'manifest.json'));
    expect(manifest.counts.scanEntries).toBe(0);
    expect(manifest.counts.auditEntries).toBe(0);
    expect(manifest.counts.notifications).toBe(0);
    expect(manifest.counts.webhooks).toBe(0);
  });
});
