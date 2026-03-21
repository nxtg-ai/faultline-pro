/**
 * N-110 — Tenant-scoped webhooks
 *
 * TW1–TW5   tenantId stored at create() time: key in tenant A → webhook.tenantId = A,
 *           key in tenant B → webhook.tenantId = B, admin key → tenantId = undefined,
 *           no keyId → tenantId = undefined, tenantId frozen at creation (snapshot).
 * TW6–TW9   list(tenantId) filter: returns only matching tenant's webhooks,
 *           empty for unknown tenant, no filter returns all, multiple for same tenant.
 * TW10–TW12 Cross-tenant isolation: tenant A webhooks absent from tenant B filter,
 *           global (no-tenant) webhooks absent from tenant A filter,
 *           list() consistent with route ?tenantId= param.
 * TW13–TW15 Route integration: POST /webhooks with tenant key → tenantId in response,
 *           GET /webhooks?tenantId= returns scoped webhooks, GET /webhooks without
 *           tenantId returns all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getWebhookStore, resetWebhookStore } from '../src/store/webhooks.js';
import { getTenantStore, resetTenantStore } from '../src/store/tenants.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';

beforeEach(() => {
  resetWebhookStore();
  resetTenantStore();
  resetKeyStore();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTenantWithKey(name: string) {
  const tenant = getTenantStore().create(name);
  const key    = getKeyStore().create(`key-${name}`, ['scan', 'admin']);
  getTenantStore().addKey(tenant.id, key.id);
  return { tenant, key };
}

function makeWebhook(overrides: { tenantId?: string } = {}) {
  return getWebhookStore().create(
    'https://example.com/hook',
    ['scan.complete'],
    'secret',
    overrides.tenantId,
  );
}

// ── tenantId stored at create() time ──────────────────────────────────────────

describe('WebhookStore.create — tenantId', () => {
  it('TW1: key in tenant A → created webhook has tenantId = tenant A id', () => {
    const { tenant } = createTenantWithKey('alpha');
    const wh = makeWebhook({ tenantId: tenant.id });
    expect(wh.tenantId).toBe(tenant.id);
  });

  it('TW2: key in tenant B → created webhook has tenantId = tenant B id', () => {
    const { tenant } = createTenantWithKey('beta');
    const wh = makeWebhook({ tenantId: tenant.id });
    expect(wh.tenantId).toBe(tenant.id);
  });

  it('TW3: no tenantId passed (admin key) → webhook.tenantId is undefined', () => {
    const wh = makeWebhook();
    expect(wh.tenantId).toBeUndefined();
  });

  it('TW4: explicit undefined tenantId → webhook.tenantId is undefined', () => {
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete']);
    expect(wh.tenantId).toBeUndefined();
  });

  it('TW5: tenantId is snapshot — removing key from tenant after creation does not change stored webhook', () => {
    const { tenant, key } = createTenantWithKey('gamma');
    const wh = makeWebhook({ tenantId: tenant.id });
    getTenantStore().removeKey(tenant.id, key.id);
    // The stored webhook still has the original tenantId
    const stored = getWebhookStore().getById(wh.id);
    expect(stored?.tenantId).toBe(tenant.id);
  });
});

// ── list(tenantId) filter ─────────────────────────────────────────────────────

describe('WebhookStore.list — tenantId filter', () => {
  it('TW6: list(tenantId) returns only webhooks for that tenant', () => {
    const { tenant: tA } = createTenantWithKey('alpha2');
    const { tenant: tB } = createTenantWithKey('beta2');
    makeWebhook({ tenantId: tA.id });
    makeWebhook({ tenantId: tB.id });

    const result = getWebhookStore().list(tA.id);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every((w) => w.tenantId === tA.id)).toBe(true);
  });

  it('TW7: list(unknown-tenant) returns empty array', () => {
    makeWebhook();
    const result = getWebhookStore().list('nonexistent-tenant-id');
    expect(result).toHaveLength(0);
  });

  it('TW8: list() without tenantId returns all webhooks', () => {
    const { tenant: tA } = createTenantWithKey('alpha3');
    const { tenant: tB } = createTenantWithKey('beta3');
    makeWebhook({ tenantId: tA.id });
    makeWebhook({ tenantId: tB.id });
    makeWebhook(); // global

    const all = getWebhookStore().list();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it('TW9: multiple webhooks for same tenant all returned by list(tenantId)', () => {
    const { tenant } = createTenantWithKey('delta');
    makeWebhook({ tenantId: tenant.id });
    makeWebhook({ tenantId: tenant.id });
    makeWebhook({ tenantId: tenant.id });

    const result = getWebhookStore().list(tenant.id);
    expect(result).toHaveLength(3);
    expect(result.every((w) => w.tenantId === tenant.id)).toBe(true);
  });
});

// ── Cross-tenant isolation ────────────────────────────────────────────────────

describe('WebhookStore.list — cross-tenant isolation', () => {
  it('TW10: tenant A webhooks absent from tenant B filter', () => {
    const { tenant: tA } = createTenantWithKey('alpha4');
    const { tenant: tB } = createTenantWithKey('beta4');
    makeWebhook({ tenantId: tA.id });
    makeWebhook({ tenantId: tB.id });

    const aList = getWebhookStore().list(tA.id);
    const bList = getWebhookStore().list(tB.id);

    expect(aList.every((w) => w.tenantId === tA.id)).toBe(true);
    expect(bList.every((w) => w.tenantId === tB.id)).toBe(true);
    // Negative assertions
    expect(aList.some((w) => w.tenantId === tB.id)).toBe(false);
    expect(bList.some((w) => w.tenantId === tA.id)).toBe(false);
  });

  it('TW11: global (no-tenant) webhooks absent from tenant filter', () => {
    const { tenant } = createTenantWithKey('alpha5');
    makeWebhook({ tenantId: tenant.id });
    makeWebhook(); // global — tenantId = undefined

    const tenantList = getWebhookStore().list(tenant.id);
    expect(tenantList.some((w) => w.tenantId === undefined)).toBe(false);
    expect(tenantList.every((w) => w.tenantId === tenant.id)).toBe(true);
  });

  it('TW12: list(tenantId) and list() are consistent — tenant subset is a subset of all', () => {
    const { tenant } = createTenantWithKey('epsilon');
    makeWebhook({ tenantId: tenant.id });
    makeWebhook(); // global

    const all      = getWebhookStore().list();
    const scoped   = getWebhookStore().list(tenant.id);

    expect(all.length).toBeGreaterThan(scoped.length);
    for (const w of scoped) {
      expect(all.some((a) => a.id === w.id)).toBe(true);
    }
  });
});

// ── Route integration ─────────────────────────────────────────────────────────

describe('GET /webhooks?tenantId= and POST /webhooks — route', () => {
  it('TW13: POST /webhooks with tenant key → response contains tenantId', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-tw13';

    const { tenant, key } = createTenantWithKey('alpha6');

    const res = await server.inject({
      method: 'POST',
      url: '/webhooks',
      headers: { 'x-api-key': key.key },
      payload: { url: 'https://example.com/hook', events: ['scan.complete'] },
    });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.tenantId).toBe(tenant.id);
  });

  it('TW14: GET /webhooks?tenantId= returns only that tenant\'s webhooks', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-tw14';

    const { tenant: tA } = createTenantWithKey('alpha7');
    const { tenant: tB } = createTenantWithKey('beta7');
    makeWebhook({ tenantId: tA.id });
    makeWebhook({ tenantId: tB.id });

    const res = await server.inject({
      method: 'GET',
      url: `/webhooks?tenantId=${tA.id}`,
      headers: { 'x-api-key': 'test-tw14' },
    });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;

    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body) as Array<{ tenantId: string }>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((w) => w.tenantId === tA.id)).toBe(true);
    expect(list.some((w) => w.tenantId === tB.id)).toBe(false);
  });

  it('TW15: GET /webhooks without tenantId returns all webhooks', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-tw15';

    const { tenant: tA } = createTenantWithKey('alpha8');
    const { tenant: tB } = createTenantWithKey('beta8');
    makeWebhook({ tenantId: tA.id });
    makeWebhook({ tenantId: tB.id });
    makeWebhook(); // global

    const res = await server.inject({
      method: 'GET',
      url: '/webhooks',
      headers: { 'x-api-key': 'test-tw15' },
    });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;

    expect(res.statusCode).toBe(200);
    const list = JSON.parse(res.body) as Array<{ tenantId?: string }>;
    expect(list.length).toBeGreaterThanOrEqual(3);
  });
});
