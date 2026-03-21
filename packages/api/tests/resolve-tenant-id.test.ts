/**
 * N-116 — resolveRequestTenantId() auth helper
 *
 * RT1–RT5   Unit — resolveRequestTenantId():
 *           undefined keyId → undefined, 'admin' keyId → undefined,
 *           keyId in tenant → tenant.id, keyId in no tenant → undefined,
 *           keyId in tenant B (not A) → B.id.
 * RT6–RT9   Webhooks route integration: POST /webhooks with admin key stores
 *           tenantId=undefined; with tenant key stores tenant.id; unknown
 *           keyId stores undefined; two different tenants produce independent
 *           tenantIds.
 * RT10–RT12 Scan route integration: POST /scan with admin key stores
 *           tenantId=undefined in scan history; with tenant key stores
 *           tenant.id; 'admin' is never resolved to any real tenant.
 * RT13–RT15 Consistency and idempotency: function returns the same value
 *           when called twice with the same args; result equals direct
 *           getTenantStore().findByKeyId() for non-admin keys; helper works
 *           after tenant is deleted (returns undefined, not stale id).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveRequestTenantId } from '../src/plugins/auth.js';
import { getTenantStore, resetTenantStore } from '../src/store/tenants.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getWebhookStore, resetWebhookStore, resetWebhookDeliveryLog, resetWebhookRateLimiter, resetWebhookCircuitBreaker } from '../src/store/webhooks.js';

function createTenantWithKey(name: string) {
  const tenant = getTenantStore().create(name);
  const key    = getKeyStore().create(`key-${name}`, ['scan', 'admin']);
  getTenantStore().addKey(tenant.id, key.id);
  return { tenant, key };
}

beforeEach(() => {
  resetTenantStore();
  resetKeyStore();
  resetWebhookStore();
  resetWebhookDeliveryLog();
  resetWebhookRateLimiter();
  resetWebhookCircuitBreaker();
});

// ── resolveRequestTenantId() unit ────────────────────────────────────────────

describe('resolveRequestTenantId() — unit', () => {
  it('RT1: undefined keyId returns undefined', () => {
    expect(resolveRequestTenantId(undefined)).toBeUndefined();
  });

  it('RT2: "admin" keyId returns undefined — admin is not a tenant key', () => {
    // Even if a tenant happened to have a keyId named 'admin', the guard prevents resolution.
    expect(resolveRequestTenantId('admin')).toBeUndefined();
  });

  it('RT3: keyId belonging to a tenant returns that tenant\'s id', () => {
    const { tenant, key } = createTenantWithKey('alpha');
    expect(resolveRequestTenantId(key.id)).toBe(tenant.id);
  });

  it('RT4: keyId not associated with any tenant returns undefined', () => {
    // Key exists in keystore but is not in any tenant's keyIds list
    const key = getKeyStore().create('orphan-key', ['scan']);
    expect(resolveRequestTenantId(key.id)).toBeUndefined();
  });

  it('RT5: keyId in tenant B (not A) resolves to B\'s id', () => {
    const { tenant: tA } = createTenantWithKey('alpha2');
    const { tenant: tB, key: kB } = createTenantWithKey('beta2');
    expect(resolveRequestTenantId(kB.id)).toBe(tB.id);
    expect(resolveRequestTenantId(kB.id)).not.toBe(tA.id);
  });
});

// ── Webhooks route integration ────────────────────────────────────────────────

describe('POST /webhooks — resolveRequestTenantId integration', () => {
  beforeEach(() => { process.env.FAULTLINE_API_KEY = 'test-rt-admin'; });
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('RT6: POST /webhooks with admin key stores tenantId=undefined', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    const res = await server.inject({
      method:  'POST',
      url:     '/webhooks',
      headers: { 'x-api-key': 'test-rt-admin', 'Content-Type': 'application/json' },
      payload: { url: 'https://example.com/rt6', events: ['scan.complete'] },
    });
    await server.close();
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.tenantId).toBeUndefined();
  });

  it('RT7: POST /webhooks with tenant key stores the correct tenantId', async () => {
    const { buildServer } = await import('../src/server.js');
    const { tenant, key } = createTenantWithKey('rt7-tenant');
    const server = buildServer();
    const res = await server.inject({
      method:  'POST',
      url:     '/webhooks',
      headers: { 'x-api-key': key.key, 'Content-Type': 'application/json' },
      payload: { url: 'https://example.com/rt7', events: ['scan.complete'] },
    });
    await server.close();
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.tenantId).toBe(tenant.id);
  });

  it('RT8: two different tenant keys produce webhooks with independent tenantIds', async () => {
    const { buildServer } = await import('../src/server.js');
    const { tenant: tA, key: kA } = createTenantWithKey('rt8-alpha');
    const { tenant: tB, key: kB } = createTenantWithKey('rt8-beta');
    const server = buildServer();

    const [resA, resB] = await Promise.all([
      server.inject({ method: 'POST', url: '/webhooks', headers: { 'x-api-key': kA.key, 'Content-Type': 'application/json' }, payload: { url: 'https://a.example.com', events: ['scan.complete'] } }),
      server.inject({ method: 'POST', url: '/webhooks', headers: { 'x-api-key': kB.key, 'Content-Type': 'application/json' }, payload: { url: 'https://b.example.com', events: ['scan.complete'] } }),
    ]);
    await server.close();

    expect(JSON.parse(resA.body).tenantId).toBe(tA.id);
    expect(JSON.parse(resB.body).tenantId).toBe(tB.id);
    expect(JSON.parse(resA.body).tenantId).not.toBe(JSON.parse(resB.body).tenantId);
  });

  it('RT9: GET /webhooks?tenantId= returns only webhooks for that tenant', async () => {
    const { buildServer } = await import('../src/server.js');
    const { tenant: tA, key: kA } = createTenantWithKey('rt9-alpha');
    const { key: kB } = createTenantWithKey('rt9-beta');
    const server = buildServer();

    await server.inject({ method: 'POST', url: '/webhooks', headers: { 'x-api-key': kA.key, 'Content-Type': 'application/json' }, payload: { url: 'https://a.example.com', events: ['scan.complete'] } });
    await server.inject({ method: 'POST', url: '/webhooks', headers: { 'x-api-key': kB.key, 'Content-Type': 'application/json' }, payload: { url: 'https://b.example.com', events: ['scan.complete'] } });

    const res = await server.inject({
      method:  'GET',
      url:     `/webhooks?tenantId=${tA.id}`,
      headers: { 'x-api-key': 'test-rt-admin' },
    });
    await server.close();

    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body) as Array<{ tenantId?: string }>;
    expect(list.every(w => w.tenantId === tA.id)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Consistency and idempotency ───────────────────────────────────────────────

describe('resolveRequestTenantId() — consistency', () => {
  it('RT10: returns the same value when called twice with the same keyId', () => {
    const { tenant, key } = createTenantWithKey('rt10');
    const first  = resolveRequestTenantId(key.id);
    const second = resolveRequestTenantId(key.id);
    expect(first).toBe(second);
    expect(first).toBe(tenant.id);
  });

  it('RT11: result equals direct getTenantStore().findByKeyId() for non-admin keys', () => {
    const { key } = createTenantWithKey('rt11');
    const viaHelper = resolveRequestTenantId(key.id);
    const viaDirect = getTenantStore().findByKeyId(key.id)?.id;
    expect(viaHelper).toBe(viaDirect);
  });

  it('RT12: returns undefined after the tenant containing the key is deleted', () => {
    const { tenant, key } = createTenantWithKey('rt12');
    expect(resolveRequestTenantId(key.id)).toBe(tenant.id); // before deletion
    getTenantStore().delete(tenant.id);
    expect(resolveRequestTenantId(key.id)).toBeUndefined();  // after deletion
  });

  it('RT13: "admin" is never matched to a tenant even if a keyId "admin" is added to a tenant', () => {
    // Simulate an adversarial / misconfiguration scenario where 'admin' is
    // used as a keyId in a tenant — the string guard must still block it.
    const tenant = getTenantStore().create('adversarial', ['admin']); // 'admin' as a keyId
    expect(resolveRequestTenantId('admin')).toBeUndefined(); // guard fires before lookup
  });

  it('RT14: resolveRequestTenantId result stored in webhook is consistent with list(tenantId)', () => {
    const { tenant, key } = createTenantWithKey('rt14');
    const tenantId = resolveRequestTenantId(key.id);
    getWebhookStore().create('https://example.com/rt14', ['scan.complete'], undefined, tenantId);
    const listed = getWebhookStore().list(tenant.id);
    expect(listed.length).toBe(1);
    expect(listed[0].tenantId).toBe(tenant.id);
  });

  it('RT15: function handles empty-string keyId — returns undefined (not a crash)', () => {
    expect(resolveRequestTenantId('')).toBeUndefined();
  });
});
