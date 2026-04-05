import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetUsageMeter, getUsageMeter } from '../src/store/usage.js';
import { resetTenantStore, getTenantStore } from '../src/store/tenants.js';
import type { FastifyInstance } from 'fastify';

function makeServer(): FastifyInstance {
  return buildServer();
}

describe('Tenants API', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-test-key';
    resetKeyStore();
    resetUsageMeter();
    resetTenantStore();
    server = makeServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('T1: POST /tenants creates tenant with correct shape (201)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/tenants',
      headers: { 'x-api-key': 'admin-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp' }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.name).toBe('Acme Corp');
    expect(Array.isArray(body.keyIds)).toBe(true);
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('T2: GET /tenants lists all tenants (Gate 2: length > 0 after create)', async () => {
    getTenantStore().create('Tenant A');
    getTenantStore().create('Tenant B');
    const res = await server.inject({
      method: 'GET',
      url: '/tenants',
      headers: { 'x-api-key': 'admin-test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBe(2);
  });

  it('T3: GET /tenants/:id returns the correct tenant', async () => {
    const tenant = getTenantStore().create('Widget Co');
    const res = await server.inject({
      method: 'GET',
      url: `/tenants/${tenant.id}`,
      headers: { 'x-api-key': 'admin-test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(tenant.id);
    expect(body.name).toBe('Widget Co');
  });

  it('T4: GET /tenants/:id returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/tenants/nonexistent-id',
      headers: { 'x-api-key': 'admin-test-key' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('T5: DELETE /tenants/:id removes tenant (200)', async () => {
    const tenant = getTenantStore().create('To Delete');
    const res = await server.inject({
      method: 'DELETE',
      url: `/tenants/${tenant.id}`,
      headers: { 'x-api-key': 'admin-test-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(getTenantStore().get(tenant.id)).toBeUndefined();
  });

  it('T6: DELETE /tenants/:id returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/tenants/nonexistent-id',
      headers: { 'x-api-key': 'admin-test-key' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('T7: POST /tenants/:id/keys adds keyId to tenant', async () => {
    const tenant = getTenantStore().create('Key Holder');
    const key = getKeyStore().create('Some Key', ['scan']);
    const res = await server.inject({
      method: 'POST',
      url: `/tenants/${tenant.id}/keys`,
      headers: { 'x-api-key': 'admin-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ keyId: key.id }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.keyIds).toContain(key.id);
  });

  it('T8: DELETE /tenants/:id/keys/:keyId removes key from tenant', async () => {
    const key = getKeyStore().create('Removable', ['scan']);
    const tenant = getTenantStore().create('With Key', [key.id]);
    const res = await server.inject({
      method: 'DELETE',
      url: `/tenants/${tenant.id}/keys/${key.id}`,
      headers: { 'x-api-key': 'admin-test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.keyIds).not.toContain(key.id);
  });

  it('T9: GET /tenants/:id/usage returns correct usage shape', async () => {
    const tenant = getTenantStore().create('Usage Tenant');
    const res = await server.inject({
      method: 'GET',
      url: `/tenants/${tenant.id}/usage`,
      headers: { 'x-api-key': 'admin-test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tenantId).toBe(tenant.id);
    expect(body.name).toBe('Usage Tenant');
    expect(Array.isArray(body.keyIds)).toBe(true);
    expect(typeof body.usage).toBe('object');
  });

  it('T10: POST /tenants requires admin — no key → 403', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/tenants',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sneaky' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('T11: GET /tenants requires admin — non-admin key → 403', async () => {
    const scanKey = getKeyStore().create('scan-only', ['scan']);
    const res = await server.inject({
      method: 'GET',
      url: '/tenants',
      headers: { 'x-api-key': scanKey.key },
    });
    expect(res.statusCode).toBe(403);
  });

  it('T12: GET /tenants/:id/usage aggregates usage across multiple keyIds', async () => {
    const key1 = getKeyStore().create('Key 1', ['scan']);
    const key2 = getKeyStore().create('Key 2', ['scan']);
    const tenant = getTenantStore().create('Multi-Key Tenant', [key1.id, key2.id]);

    const today = new Date().toISOString().split('T')[0];
    const meter = getUsageMeter();
    meter.increment(key1.id);
    meter.increment(key1.id);
    meter.increment(key2.id);

    const res = await server.inject({
      method: 'GET',
      url: `/tenants/${tenant.id}/usage`,
      headers: { 'x-api-key': 'admin-test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.usage[today]).toBe(3);
  });
});
