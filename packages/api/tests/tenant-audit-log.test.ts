/**
 * N-111 — Tenant-scoped audit log
 *
 * TA1–TA5   tenantId resolved at log() time: key in tenant A → entry.tenantId = A,
 *           key in tenant B → entry.tenantId = B, orphan key → undefined,
 *           'unknown' keyId → undefined, tenantId frozen at log time (snapshot).
 * TA6–TA9   filterEntries tenantId filter: returns only matching tenant entries,
 *           empty for unknown tenant, no filter returns all, limit applies within scope.
 * TA10–TA12 Cross-tenant isolation: tenant A entries absent from tenant B filter,
 *           global ('unknown') entries absent from tenant filter,
 *           tenantId + keyId filters ANDed.
 * TA13–TA15 Route integration: GET /audit/log?tenantId= returns scoped entries,
 *           unknown tenant → empty, tenantId field present on every returned entry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAuditLogger, resetAuditLogger } from '../src/store/audit.js';
import { getTenantStore, resetTenantStore } from '../src/store/tenants.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';

beforeEach(() => {
  resetAuditLogger();
  resetTenantStore();
  resetKeyStore();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTenantWithKey(name: string) {
  const tenant = getTenantStore().create(name);
  const key    = getKeyStore().create(`key-${name}`, ['scan']);
  getTenantStore().addKey(tenant.id, key.id);
  return { tenant, key };
}

function logEntry(keyId: string, endpoint = '/scan', statusCode = 200) {
  getAuditLogger().log({
    timestamp:  new Date().toISOString(),
    keyId,
    endpoint,
    method:     'POST',
    statusCode,
    latencyMs:  10,
  });
}

// ── tenantId resolved at log() time ──────────────────────────────────────────

describe('AuditLogger.log — tenantId resolution', () => {
  it('TA1: key in tenant A → entry.tenantId = tenant A id', () => {
    const { tenant, key } = createTenantWithKey('alpha');
    logEntry(key.id);
    const entries = getAuditLogger().getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].tenantId).toBe(tenant.id);
  });

  it('TA2: key in tenant B → entry.tenantId = tenant B id', () => {
    const { tenant, key } = createTenantWithKey('beta');
    logEntry(key.id);
    const entries = getAuditLogger().getEntries();
    expect(entries[0].tenantId).toBe(tenant.id);
  });

  it('TA3: orphan key (not in any tenant) → entry.tenantId is undefined', () => {
    const key = getKeyStore().create('orphan', ['scan']);
    logEntry(key.id);
    const entries = getAuditLogger().getEntries();
    expect(entries[0].tenantId).toBeUndefined();
  });

  it('TA4: special keyId "unknown" → entry.tenantId is undefined', () => {
    logEntry('unknown');
    const entries = getAuditLogger().getEntries();
    expect(entries[0].tenantId).toBeUndefined();
  });

  it('TA5: tenantId snapshot — removing key from tenant after log does not change stored entry', () => {
    const { tenant, key } = createTenantWithKey('gamma');
    logEntry(key.id);
    getTenantStore().removeKey(tenant.id, key.id);
    const entries = getAuditLogger().getEntries();
    expect(entries[0].tenantId).toBe(tenant.id);
  });
});

// ── filterEntries tenantId filter (via store) ─────────────────────────────────

describe('AuditLogger — tenantId filtering', () => {
  it('TA6: getEntries scoped by tenantId returns only matching entries', () => {
    const { tenant: tA, key: kA } = createTenantWithKey('alpha2');
    const { key: kB }             = createTenantWithKey('beta2');
    logEntry(kA.id);
    logEntry(kB.id);
    logEntry('unknown');

    const all = getAuditLogger().getEntries();
    const scoped = all.filter(e => e.tenantId === tA.id);
    expect(scoped.length).toBeGreaterThanOrEqual(1);
    expect(scoped.every(e => e.tenantId === tA.id)).toBe(true);
  });

  it('TA7: filter by unknown tenantId returns zero entries', () => {
    logEntry('unknown');
    const all = getAuditLogger().getEntries();
    const scoped = all.filter(e => e.tenantId === 'nonexistent-tenant');
    expect(scoped).toHaveLength(0);
  });

  it('TA8: no tenantId filter returns all entries', () => {
    const { key: kA } = createTenantWithKey('alpha3');
    const { key: kB } = createTenantWithKey('beta3');
    logEntry(kA.id);
    logEntry(kB.id);
    logEntry('unknown');

    const all = getAuditLogger().getEntries();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it('TA9: multiple log entries for same tenant all present in scoped filter', () => {
    const { tenant, key } = createTenantWithKey('delta');
    for (let i = 0; i < 4; i++) logEntry(key.id, `/scan/${i}`);

    const scoped = getAuditLogger().getEntries().filter(e => e.tenantId === tenant.id);
    expect(scoped).toHaveLength(4);
    expect(scoped.every(e => e.tenantId === tenant.id)).toBe(true);
  });
});

// ── Cross-tenant isolation ────────────────────────────────────────────────────

describe('AuditLogger — cross-tenant isolation', () => {
  it('TA10: tenant A entries absent from tenant B filter', () => {
    const { tenant: tA, key: kA } = createTenantWithKey('alpha4');
    const { tenant: tB, key: kB } = createTenantWithKey('beta4');
    logEntry(kA.id);
    logEntry(kB.id);

    const all = getAuditLogger().getEntries();
    const aScoped = all.filter(e => e.tenantId === tA.id);
    const bScoped = all.filter(e => e.tenantId === tB.id);

    expect(aScoped.every(e => e.tenantId === tA.id)).toBe(true);
    expect(bScoped.every(e => e.tenantId === tB.id)).toBe(true);
    expect(aScoped.some(e => e.tenantId === tB.id)).toBe(false);
    expect(bScoped.some(e => e.tenantId === tA.id)).toBe(false);
  });

  it('TA11: global entries (tenantId = undefined) absent from tenant filter', () => {
    const { tenant, key } = createTenantWithKey('alpha5');
    logEntry(key.id);
    logEntry('unknown');        // global
    logEntry('scheduler');      // global

    const all = getAuditLogger().getEntries();
    const tenantScoped = all.filter(e => e.tenantId === tenant.id);
    expect(tenantScoped.some(e => e.tenantId === undefined)).toBe(false);
    expect(tenantScoped.every(e => e.tenantId === tenant.id)).toBe(true);
  });

  it('TA12: tenantId filter AND keyId filter ANDed — only entries matching both', () => {
    const { tenant: tA, key: kA } = createTenantWithKey('alpha6');
    const { key: kB }             = createTenantWithKey('beta6');
    logEntry(kA.id);
    logEntry(kB.id);

    const all = getAuditLogger().getEntries();
    const filtered = all.filter(e => e.tenantId === tA.id && e.keyId === kA.id);
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered.every(e => e.tenantId === tA.id && e.keyId === kA.id)).toBe(true);
  });
});

// ── Route integration ─────────────────────────────────────────────────────────

describe('GET /audit/log?tenantId= — route', () => {
  afterEach(() => {
    delete process.env.FAULTLINE_API_KEY;
  });

  it('TA13: returns only entries for the specified tenant', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-ta13';

    const { tenant: tA, key: kA } = createTenantWithKey('alpha7');
    const { key: kB }             = createTenantWithKey('beta7');
    logEntry(kA.id);
    logEntry(kB.id);

    const res = await server.inject({
      method: 'GET',
      url: `/audit/log?tenantId=${tA.id}`,
      headers: { 'x-api-key': 'test-ta13' },
    });
    await server.close();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { entries: Array<{ tenantId: string }> };
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.entries.every(e => e.tenantId === tA.id)).toBe(true);
    expect(body.entries.some(e => e.tenantId !== tA.id)).toBe(false);
  });

  it('TA14: unknown tenantId returns empty entries array', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-ta14';

    logEntry('unknown');

    const res = await server.inject({
      method: 'GET',
      url: '/audit/log?tenantId=no-such-tenant',
      headers: { 'x-api-key': 'test-ta14' },
    });
    await server.close();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { entries: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.entries).toHaveLength(0);
  });

  it('TA15: tenantId field present on every returned entry', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-ta15';

    const { tenant, key } = createTenantWithKey('alpha8');
    logEntry(key.id);

    const res = await server.inject({
      method: 'GET',
      url: `/audit/log?tenantId=${tenant.id}`,
      headers: { 'x-api-key': 'test-ta15' },
    });
    await server.close();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { entries: Array<{ tenantId: string }> };
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of body.entries) {
      expect(entry).toHaveProperty('tenantId');
      expect(entry.tenantId).toBe(tenant.id);
    }
  });
});
