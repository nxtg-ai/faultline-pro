/**
 * Customer API keys are closed until tenancy is fixed (emma-soul
 * al:837ec6cea3437a7d, ruling 1). Every path that issues a key refuses a
 * non-admin key unless FAULTLINE_CUSTOMER_KEYS=on; admin (operator) keys stay
 * issuable; an org role never mints a fleet-wide admin key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getOrgStore, resetOrgStore } from '../src/store/orgs.js';
import type { FastifyInstance } from 'fastify';

const ADMIN = 'gate-admin-key';
const H = { 'x-api-key': ADMIN, 'content-type': 'application/json' };

describe('customer key issuance is closed', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    delete process.env.FAULTLINE_CUSTOMER_KEYS;
    resetKeyStore(); resetOrgStore();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    delete process.env.FAULTLINE_CUSTOMER_KEYS;
    delete process.env.FAULTLINE_GRAPHQL;
  });

  it.each([[undefined], [['scan']], [['scan', 'pro']], [['report', 'upload']]])('KG-1. POST /keys with permissions %j is refused and creates nothing', async (permissions) => {
    const res = await server.inject({ method: 'POST', url: '/keys', headers: H, body: JSON.stringify({ name: 'customer', ...(permissions ? { permissions } : {}) }) });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('customer_keys_closed');
    expect(getKeyStore().list().length).toBe(0);
  });

  it('KG-2. an admin (operator) key can still be created', async () => {
    const res = await server.inject({ method: 'POST', url: '/keys', headers: H, body: JSON.stringify({ name: 'operator', permissions: ['admin', 'scan'] }) });
    expect(res.statusCode).toBe(201);
  });

  it('KG-3. with FAULTLINE_CUSTOMER_KEYS=on a customer key is issued', async () => {
    process.env.FAULTLINE_CUSTOMER_KEYS = 'on';
    const res = await server.inject({ method: 'POST', url: '/keys', headers: H, body: JSON.stringify({ name: 'customer', permissions: ['scan'] }) });
    expect(res.statusCode).toBe(201);
  });

  it('KG-4. org keys: customer keys refused while closed; an org admin never mints an admin key', async () => {
    const orgAdmin = getKeyStore().create('org owner', ['scan']);
    const org = getOrgStore().create({ name: 'Acme' }, orgAdmin.id);
    const asOrgAdmin = { 'x-api-key': orgAdmin.key, 'content-type': 'application/json' };
    const closed = await server.inject({ method: 'POST', url: `/orgs/${org.id}/keys`, headers: asOrgAdmin, body: JSON.stringify({ name: 'k', permissions: ['scan'] }) });
    expect(closed.statusCode).toBe(403);
    process.env.FAULTLINE_CUSTOMER_KEYS = 'on';
    const escalate = await server.inject({ method: 'POST', url: `/orgs/${org.id}/keys`, headers: asOrgAdmin, body: JSON.stringify({ name: 'k', permissions: ['admin'] }) });
    expect(escalate.statusCode).toBe(403);
    expect(getKeyStore().list().filter((k) => k.permissions.includes('admin')).length).toBe(0);
    const open = await server.inject({ method: 'POST', url: `/orgs/${org.id}/keys`, headers: asOrgAdmin, body: JSON.stringify({ name: 'k', permissions: ['scan'] }) });
    expect(open.statusCode).toBe(201);
  });

  it('KG-6. PATCH cannot re-scope a key into a customer key while closed', async () => {
    const created = await server.inject({ method: 'POST', url: '/keys', headers: H, body: JSON.stringify({ name: 'operator', permissions: ['admin', 'scan'] }) });
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).id;
    const nonAdmin = () => getKeyStore().list().filter((k) => !k.permissions.includes('admin')).length;
    for (const permissions of [['scan'], [], ['scan', 'report']]) {
      const res = await server.inject({ method: 'PATCH', url: `/keys/${id}`, headers: H, body: JSON.stringify({ permissions }) });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toBe('customer_keys_closed');
    }
    expect(nonAdmin()).toBe(0);
    expect(getKeyStore().validateById(id)!.permissions).toContain('admin');
    const rename = await server.inject({ method: 'PATCH', url: `/keys/${id}`, headers: H, body: JSON.stringify({ name: 'renamed' }) });
    expect(rename.statusCode).toBe(200);
    const keepAdmin = await server.inject({ method: 'PATCH', url: `/keys/${id}`, headers: H, body: JSON.stringify({ permissions: ['admin'] }) });
    expect(keepAdmin.statusCode).toBe(200);
    process.env.FAULTLINE_CUSTOMER_KEYS = 'on';
    const open = await server.inject({ method: 'PATCH', url: `/keys/${id}`, headers: H, body: JSON.stringify({ permissions: ['scan'] }) });
    expect(open.statusCode).toBe(200);
    expect(nonAdmin()).toBe(1);
  });

  it('KG-5. GraphQL createKey refuses a customer key while closed', async () => {
    process.env.FAULTLINE_GRAPHQL = 'on';
    const s2 = buildServer();
    await s2.ready();
    const res = await s2.inject({ method: 'POST', url: '/graphql', headers: H, body: JSON.stringify({ query: 'mutation { createKey(name: "c", permissions: ["scan"]) { id } }' }) });
    await s2.close();
    expect(JSON.parse(res.body).errors?.[0]?.message).toMatch(/not being issued/);
    expect(getKeyStore().list().length).toBe(0);
  });
});
