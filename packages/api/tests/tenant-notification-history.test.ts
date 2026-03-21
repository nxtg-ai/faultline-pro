/**
 * N-108 — Tenant-scoped notifications
 *
 * TN1–TN5   tenantId resolved at _deliver() time: key in tenant A → record.tenantId = A,
 *           key in tenant B → record.tenantId = B, untenanted key → tenantId = undefined,
 *           global '*' key → tenantId = undefined, tenantId persists after key deletion.
 * TN6–TN9   getHistory(undefined, limit, tenantId) filter: returns only matching tenant,
 *           empty result for unknown tenant, limit still applies within tenant scope,
 *           getHistory without tenantId returns all records unchanged.
 * TN10–TN12 Cross-tenant isolation: tenant A records absent from tenant B filter,
 *           global (* keyId) records absent from tenant A filter,
 *           tenantId filter + keyId filter are ANDed correctly.
 * TN13–TN15 Route integration: GET /notifications/history?tenantId= returns scoped records,
 *           returns zero records for unknown tenant, tenantId field present in each record.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getNotificationStore,
  resetNotificationStore,
} from '../src/store/notifications.js';
import { getTenantStore, resetTenantStore } from '../src/store/tenants.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';

// Suppress fetch errors in delivery tests
beforeEach(() => {
  resetNotificationStore();
  resetTenantStore();
  resetKeyStore();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTenantWithKey(tenantName: string) {
  const tenant = getTenantStore().create(tenantName);
  const key    = getKeyStore().create(`key-${tenantName}`, ['scan']);
  getTenantStore().addKey(tenant.id, key.id);
  return { tenant, key };
}

async function dispatchToKey(keyId: string) {
  getNotificationStore().setPrefs(keyId, ['scan.failed'], 'https://example.com/hook', null);
  await getNotificationStore().dispatch('scan.failed', { error: 'test', provider: 'gemini' }, keyId);
}

// ── tenantId resolution at dispatch time ──────────────────────────────────────

describe('NotificationRecord.tenantId — resolution', () => {
  it('TN1: key associated with tenant A → record.tenantId = tenant A id', async () => {
    const { tenant, key } = createTenantWithKey('alpha');
    await dispatchToKey(key.id);
    const records = getNotificationStore().getHistory(key.id, 10);
    expect(records).toHaveLength(1);
    expect(records[0].tenantId).toBe(tenant.id);
  });

  it('TN2: key associated with tenant B → record.tenantId = tenant B id', async () => {
    const { tenant, key } = createTenantWithKey('beta');
    await dispatchToKey(key.id);
    const records = getNotificationStore().getHistory(key.id, 10);
    expect(records[0].tenantId).toBe(tenant.id);
  });

  it('TN3: key not associated with any tenant → tenantId is undefined', async () => {
    const key = getKeyStore().create('orphan-key', ['scan']);
    await dispatchToKey(key.id);
    const records = getNotificationStore().getHistory(key.id, 10);
    expect(records[0].tenantId).toBeUndefined();
  });

  it('TN4: global keyId "*" → tenantId is undefined', async () => {
    // Dispatch via global fallback (no prefs, no targetKeyId, global env var)
    const originalEnv = process.env.FAULTLINE_NOTIFY_WEBHOOK;
    process.env.FAULTLINE_NOTIFY_WEBHOOK = 'https://example.com/global';
    await getNotificationStore().dispatch('scan.failed', { error: 'test', provider: 'mock' });
    if (originalEnv !== undefined) {
      process.env.FAULTLINE_NOTIFY_WEBHOOK = originalEnv;
    } else {
      delete process.env.FAULTLINE_NOTIFY_WEBHOOK;
    }
    const records = getNotificationStore().getHistory(undefined, 10);
    const starRecord = records.find(r => r.keyId === '*');
    expect(starRecord).toBeDefined();
    expect(starRecord!.tenantId).toBeUndefined();
  });

  it('TN5: tenantId in record is frozen at dispatch time (snapshot)', async () => {
    const { tenant, key } = createTenantWithKey('gamma');
    await dispatchToKey(key.id);
    // Remove key from tenant after the fact — record should still have the tenantId
    getTenantStore().removeKey(tenant.id, key.id);
    const records = getNotificationStore().getHistory(key.id, 10);
    expect(records[0].tenantId).toBe(tenant.id);
  });
});

// ── getHistory tenantId filter ────────────────────────────────────────────────

describe('getHistory — tenantId filter', () => {
  it('TN6: tenantId filter returns only records for that tenant', async () => {
    const { tenant: tA, key: kA } = createTenantWithKey('alpha2');
    const { key: kB } = createTenantWithKey('beta2');
    await dispatchToKey(kA.id);
    await dispatchToKey(kB.id);

    const records = getNotificationStore().getHistory(undefined, 50, tA.id);
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.every(r => r.tenantId === tA.id)).toBe(true);
  });

  it('TN7: unknown tenantId returns empty array', () => {
    const records = getNotificationStore().getHistory(undefined, 50, 'nonexistent-tenant-id');
    expect(records).toHaveLength(0);
  });

  it('TN8: limit still applies within tenant scope', async () => {
    const { tenant, key } = createTenantWithKey('delta');
    // Dispatch 5 notifications
    for (let i = 0; i < 5; i++) {
      await dispatchToKey(key.id);
    }
    const records = getNotificationStore().getHistory(undefined, 2, tenant.id);
    expect(records).toHaveLength(2);
    expect(records.every(r => r.tenantId === tenant.id)).toBe(true);
  });

  it('TN9: getHistory without tenantId returns all records', async () => {
    const { key: kA } = createTenantWithKey('alpha3');
    const { key: kB } = createTenantWithKey('beta3');
    await dispatchToKey(kA.id);
    await dispatchToKey(kB.id);

    const all = getNotificationStore().getHistory(undefined, 50);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Cross-tenant isolation ────────────────────────────────────────────────────

describe('getHistory — cross-tenant isolation', () => {
  it('TN10: tenant A records absent from tenant B filter', async () => {
    const { tenant: tA, key: kA } = createTenantWithKey('alpha4');
    const { tenant: tB, key: kB } = createTenantWithKey('beta4');
    await dispatchToKey(kA.id);
    await dispatchToKey(kB.id);

    const aRecords = getNotificationStore().getHistory(undefined, 50, tA.id);
    const bRecords = getNotificationStore().getHistory(undefined, 50, tB.id);

    expect(aRecords.every(r => r.tenantId === tA.id)).toBe(true);
    expect(bRecords.every(r => r.tenantId === tB.id)).toBe(true);
    // Negative assertion — each set is exclusively scoped
    expect(aRecords.some(r => r.tenantId === tB.id)).toBe(false);
    expect(bRecords.some(r => r.tenantId === tA.id)).toBe(false);
  });

  it('TN11: global "*" records absent from tenant filter', async () => {
    const { tenant, key } = createTenantWithKey('alpha5');
    await dispatchToKey(key.id);
    // Also fire a global notification
    const originalEnv = process.env.FAULTLINE_NOTIFY_WEBHOOK;
    process.env.FAULTLINE_NOTIFY_WEBHOOK = 'https://example.com/global';
    await getNotificationStore().dispatch('scan.failed', { error: 'test', provider: 'mock' });
    if (originalEnv !== undefined) { process.env.FAULTLINE_NOTIFY_WEBHOOK = originalEnv; } else { delete process.env.FAULTLINE_NOTIFY_WEBHOOK; }

    const tenantRecords = getNotificationStore().getHistory(undefined, 50, tenant.id);
    expect(tenantRecords.some(r => r.keyId === '*')).toBe(false);
    expect(tenantRecords.every(r => r.tenantId === tenant.id)).toBe(true);
  });

  it('TN12: tenantId filter AND keyId filter are applied together', async () => {
    const { tenant: tA, key: kA } = createTenantWithKey('alpha6');
    const { key: kB } = createTenantWithKey('beta6');
    await dispatchToKey(kA.id);
    await dispatchToKey(kB.id);

    // Request keyId=kA.id AND tenantId=tA.id — should get kA's records only
    const records = getNotificationStore().getHistory(kA.id, 50, tA.id);
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.every(r => r.keyId === kA.id && r.tenantId === tA.id)).toBe(true);
  });
});

// ── Route integration ─────────────────────────────────────────────────────────

describe('GET /notifications/history?tenantId= — route', () => {
  it('TN13: returns only records for the specified tenant', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-tn13';

    const { tenant, key } = createTenantWithKey('alpha7');
    const { key: kB } = createTenantWithKey('beta7');
    await dispatchToKey(key.id);
    await dispatchToKey(kB.id);

    const res = await server.inject({
      method: 'GET',
      url: `/notifications/history?tenantId=${tenant.id}`,
      headers: { 'x-api-key': 'test-tn13' },
    });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.records.every((r: { tenantId: string }) => r.tenantId === tenant.id)).toBe(true);
    // Negative: no records from kB's tenant
    const otherTenant = getTenantStore().findByKeyId(kB.id);
    if (otherTenant) {
      expect(body.records.some((r: { tenantId: string }) => r.tenantId === otherTenant.id)).toBe(false);
    }
  });

  it('TN14: returns empty records array for unknown tenant', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-tn14';

    const res = await server.inject({
      method: 'GET',
      url: '/notifications/history?tenantId=no-such-tenant',
      headers: { 'x-api-key': 'test-tn14' },
    });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
    expect(body.records).toHaveLength(0);
  });

  it('TN15: tenantId field is present on every returned record', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-tn15';

    const { tenant, key } = createTenantWithKey('alpha8');
    await dispatchToKey(key.id);

    const res = await server.inject({
      method: 'GET',
      url: `/notifications/history?tenantId=${tenant.id}`,
      headers: { 'x-api-key': 'test-tn15' },
    });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.records.length).toBeGreaterThanOrEqual(1);
    for (const record of body.records) {
      expect(record).toHaveProperty('tenantId');
      expect(record.tenantId).toBe(tenant.id);
    }
  });
});
