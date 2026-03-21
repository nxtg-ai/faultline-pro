/**
 * N-123 — Tenant-scoped cost tracking tests (TC1–TC15)
 *
 * CostStore previously had no tenantId support — cost data was absent from
 * both the GDPR export ZIP and the erasure endpoint.
 *
 * N-123 adds:
 *   - ScanCost.tenantId? field
 *   - CostStore.record() accepts optional tenantId
 *   - CostFilter.tenantId? filter
 *   - CostStore.deleteTenantCosts(tenantId) → number
 *   - GDPR export ZIP now includes costs.json
 *   - GDPR erasure now includes costs in deleted counts
 *
 * Tests validate:
 *   - CostStore records and filters by tenantId
 *   - deleteTenantCosts() accuracy and isolation
 *   - costs.json present in GDPR export ZIP
 *   - manifest.counts.costs reflects actual count
 *   - Export tenant isolation (other tenant costs not included)
 *   - Erasure deleted.costs count accurate
 *   - Erasure isolation (other tenant costs untouched)
 *   - Costs with no tenantId (pre-N-123 records) not included in tenant queries
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import { buildServer } from '../src/server.js';
import { resetTenantStore, getTenantStore } from '../src/store/tenants.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetScanHistory } from '../src/store/scan-history.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetNotificationStore } from '../src/store/notifications.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCostStore, getCostStore } from '../src/store/costs.js';
import type { FastifyInstance } from 'fastify';

function adminHeaders() {
  return { 'x-api-key': 'admin-test-key' };
}

function zipEntry(zip: AdmZip, name: string): string {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`ZIP entry not found: ${name}`);
  return entry.getData().toString('utf-8');
}

describe('Tenant-scoped cost tracking (TC1–TC15)', () => {
  let server: FastifyInstance;
  let tenantId: string;
  let keyId: string;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'admin-test-key';
    resetTenantStore();
    resetKeyStore();
    resetScanHistory();
    resetAuditLogger();
    resetNotificationStore();
    resetWebhookStore();
    resetUsageMeter();
    resetCostStore();

    const key = getKeyStore().create('cost-key', ['scan'], 'cost-key');
    keyId = key.id;
    const tenant = getTenantStore().create('Cost Test Corp', [keyId]);
    tenantId = tenant.id;

    // Seed two cost records for this tenant
    getCostStore().record(keyId, 'mock', 'claim text one', tenantId);
    getCostStore().record(keyId, 'gemini', 'claim text two', tenantId);

    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  // ── TC1: CostStore records tenantId ───────────────────────────────────────

  it('TC1: CostStore.record() stores tenantId on the entry', () => {
    const all = getCostStore().getCosts({ keyId });
    expect(all.every(e => e.tenantId === tenantId)).toBe(true);
  });

  // ── TC2: getCosts({ tenantId }) filters by tenant ─────────────────────────

  it('TC2: getCosts({ tenantId }) returns only entries for that tenant', () => {
    // Add a cost for a different (un-tenanted) key
    getCostStore().record('other-key-id', 'mock', 'other text');
    const tenantCosts = getCostStore().getCosts({ tenantId });
    expect(tenantCosts.length).toBe(2);
    expect(tenantCosts.every(e => e.tenantId === tenantId)).toBe(true);
  });

  // ── TC3: getCosts({ tenantId }) returns empty for unknown tenant ──────────

  it('TC3: getCosts({ tenantId }) returns empty array for unknown tenant', () => {
    expect(getCostStore().getCosts({ tenantId: 'no-such' })).toHaveLength(0);
  });

  // ── TC4: deleteTenantCosts() returns correct count ─────────────────────────

  it('TC4: deleteTenantCosts() returns 2 for two seeded entries', () => {
    expect(getCostStore().deleteTenantCosts(tenantId)).toBe(2);
  });

  // ── TC5: deleteTenantCosts() actually removes entries ─────────────────────

  it('TC5: getCosts after deleteTenantCosts returns empty', () => {
    getCostStore().deleteTenantCosts(tenantId);
    expect(getCostStore().getCosts({ tenantId })).toHaveLength(0);
  });

  // ── TC6: deleteTenantCosts() is idempotent ────────────────────────────────

  it('TC6: second deleteTenantCosts call returns 0', () => {
    getCostStore().deleteTenantCosts(tenantId);
    expect(getCostStore().deleteTenantCosts(tenantId)).toBe(0);
  });

  // ── TC7: deleteTenantCosts() isolation — other tenant untouched ───────────

  it('TC7: deleteTenantCosts does not affect entries from other tenants', () => {
    const key2 = getKeyStore().create('other-k', ['scan'], 'other-k');
    const tenant2 = getTenantStore().create('Other Corp', [key2.id]);
    getCostStore().record(key2.id, 'mock', 'other text', tenant2.id);

    getCostStore().deleteTenantCosts(tenantId);
    expect(getCostStore().getCosts({ tenantId: tenant2.id })).toHaveLength(1);
  });

  // ── TC8: records without tenantId not included in tenant query ─────────────

  it('TC8: un-tenanted cost records are excluded from tenant getCosts', () => {
    getCostStore().record('bare-key', 'mock', 'bare text'); // no tenantId
    const tenantCosts = getCostStore().getCosts({ tenantId });
    expect(tenantCosts.every(e => e.tenantId === tenantId)).toBe(true);
    expect(tenantCosts).toHaveLength(2);
  });

  // ── TC9: GDPR export ZIP contains costs.json ──────────────────────────────

  it('TC9: GDPR export ZIP contains costs.json', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = new AdmZip(res.rawPayload);
    expect(zip.getEntry('costs.json')).not.toBeNull();
  });

  // ── TC10: costs.json contains seeded entries ──────────────────────────────

  it('TC10: costs.json in export contains the 2 seeded cost entries', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = new AdmZip(res.rawPayload);
    const costs = JSON.parse(zipEntry(zip, 'costs.json'));
    expect(Array.isArray(costs)).toBe(true);
    expect(costs).toHaveLength(2);
  });

  // ── TC11: manifest.counts.costs matches actual count ─────────────────────

  it('TC11: manifest.counts.costs is 2', async () => {
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = new AdmZip(res.rawPayload);
    const manifest = JSON.parse(zipEntry(zip, 'manifest.json'));
    expect(manifest.counts.costs).toBe(2);
  });

  // ── TC12: export costs.json only contains this tenant's costs ─────────────

  it('TC12: costs.json only contains entries for the requested tenant', async () => {
    getCostStore().record('other-key-x', 'mock', 'other', 'other-tenant-x');
    const res = await server.inject({ method: 'GET', url: `/tenants/${tenantId}/export`, headers: adminHeaders() });
    const zip = new AdmZip(res.rawPayload);
    const costs = JSON.parse(zipEntry(zip, 'costs.json'));
    expect(costs.every((c: { tenantId: string }) => c.tenantId === tenantId)).toBe(true);
  });

  // ── TC13: GDPR erasure response includes costs field ─────────────────────

  it('TC13: DELETE /tenants/:id/data response includes deleted.costs', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    const body = JSON.parse(res.body);
    expect(body.deleted).toHaveProperty('costs');
  });

  // ── TC14: erasure deleted.costs is 2 ─────────────────────────────────────

  it('TC14: deleted.costs is 2 after erasing tenant with 2 cost records', async () => {
    const res = await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    expect(JSON.parse(res.body).deleted.costs).toBe(2);
  });

  // ── TC15: erasure cost isolation — other tenant costs untouched ───────────

  it('TC15: erasing tenant A does not delete tenant B cost records', async () => {
    const key2 = getKeyStore().create('b-key', ['scan'], 'b-key');
    const tenant2 = getTenantStore().create('Tenant B', [key2.id]);
    getCostStore().record(key2.id, 'mock', 'b text', tenant2.id);

    await server.inject({ method: 'DELETE', url: `/tenants/${tenantId}/data`, headers: adminHeaders() });
    expect(getCostStore().getCosts({ tenantId: tenant2.id })).toHaveLength(1);
  });
});
