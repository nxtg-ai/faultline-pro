// Validates: customer-key reopen conditions, emma-soul ruling Dx3 e2909e46 (GoPMO 1.18.11.6.7 / 1.18.11.6.8)
//
// Item 3: reviving a key (enable, bulk-enable, changing or clearing expiresAt)
// is admin-only and writes one audit row per key.
// Item 4: public routes keep their statuses but strip fleet counters (key count,
// audit size, scan volume, queue sizes, notification counts) unless the caller
// sends an admin key. A customer key gets the stripped view too.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getAuditLogger, resetAuditLogger } from '../src/store/audit.js';
import { getScanQueue, resetScanQueue } from '../src/store/scan-queue.js';

const ADMIN = 'reopen-admin-key';

beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

let server: FastifyInstance;

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = ADMIN;
  resetKeyStore(); resetAuditLogger(); resetScanQueue();
  server = buildServer();
  await server.ready();
  getScanQueue().stop();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

const json = { 'content-type': 'application/json' };
const revivals = () => getAuditLogger().getEntries().filter((e) => e.note?.startsWith('key revived:'));

describe('item 3: key revival is admin-only and audited', () => {
  it('a non-admin key gets 403 on enable, bulk-enable and expiresAt changes, and nothing is revived', async () => {
    const customer = getKeyStore().create('customer', ['scan']);
    const target = getKeyStore().create('lost', ['scan']);
    getKeyStore().disable(target.id);
    const h = { 'x-api-key': customer.key, ...json };
    expect((await server.inject({ method: 'PATCH', url: `/keys/${target.id}/enable`, headers: h })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/keys/bulk-enable', headers: h, body: JSON.stringify({ ids: [target.id] }) })).statusCode).toBe(403);
    expect((await server.inject({ method: 'PATCH', url: `/keys/${target.id}`, headers: h, body: JSON.stringify({ expiresAt: null }) })).statusCode).toBe(403);
    expect(getKeyStore().validateById(target.id)?.disabled).toBe(true);
    expect(revivals()).toEqual([]);
  });

  it('admin enable writes one audit row naming the key', async () => {
    const target = getKeyStore().create('lost', ['scan']);
    getKeyStore().disable(target.id);
    const res = await server.inject({ method: 'PATCH', url: `/keys/${target.id}/enable`, headers: { 'x-api-key': ADMIN } });
    expect(res.statusCode).toBe(200);
    expect(revivals().map((e) => e.note)).toEqual([`key revived: ${target.id} (enable)`]);
    expect(revivals()[0].keyId).toBe('admin');
  });

  it('admin bulk-enable writes a row per revived key', async () => {
    const a = getKeyStore().create('a', ['scan']);
    const b = getKeyStore().create('b', ['scan']);
    getKeyStore().disable(a.id); getKeyStore().disable(b.id);
    const res = await server.inject({ method: 'POST', url: '/keys/bulk-enable', headers: { 'x-api-key': ADMIN, ...json }, body: JSON.stringify({ ids: [a.id, b.id] }) });
    expect(res.statusCode).toBe(200);
    expect(revivals().map((e) => e.note).sort()).toEqual([`key revived: ${a.id} (bulk-enable)`, `key revived: ${b.id} (bulk-enable)`].sort());
  });

  it('admin clearing or moving expiresAt writes an audit row; a rename does not', async () => {
    const target = getKeyStore().create('expired', ['scan'], new Date(Date.now() - 1000).toISOString());
    const h = { 'x-api-key': ADMIN, ...json };
    expect((await server.inject({ method: 'PATCH', url: `/keys/${target.id}`, headers: h, body: JSON.stringify({ name: 'renamed' }) })).statusCode).toBe(200);
    expect(revivals()).toEqual([]);
    expect((await server.inject({ method: 'PATCH', url: `/keys/${target.id}`, headers: h, body: JSON.stringify({ expiresAt: null }) })).statusCode).toBe(200);
    expect(revivals().map((e) => e.note)).toEqual([`key revived: ${target.id} (expiresAt cleared)`]);
  });
});

describe('item 4: public routes strip fleet counters unless the caller is admin', () => {
  async function seedFleet(): Promise<string> {
    const customer = getKeyStore().create('customer', ['scan']);
    getKeyStore().create('another', ['scan']);
    getScanQueue().enqueue(customer.id, 2, 'queued text', 'mock');
    return customer.key;
  }

  it('/health and /health/deep: statuses for everyone, counts for admin only', async () => {
    const customerKey = await seedFleet();
    for (const headers of [{}, { 'x-api-key': customerKey }]) {
      const health = JSON.parse((await server.inject({ method: 'GET', url: '/health', headers })).body);
      expect(health.status).toBe('ok');
      expect(health.subsystems.keyStore).toEqual({ status: 'ok' });
      const deep = JSON.parse((await server.inject({ method: 'GET', url: '/health/deep', headers })).body);
      expect(deep.subsystems.keyStore).toEqual({ status: 'ok' });
      expect(deep.subsystems.auditLog).toEqual({ status: 'ok' });
      expect(deep.subsystems.analytics).toEqual({ status: 'ok' });
    }
    const admin = JSON.parse((await server.inject({ method: 'GET', url: '/health/deep', headers: { 'x-api-key': ADMIN } })).body);
    expect(admin.subsystems.keyStore.activeKeys).toBe(2);
    expect(typeof admin.subsystems.auditLog.entries).toBe('number');
    expect(typeof admin.subsystems.analytics.totalScans).toBe('number');
  });

  it('/status.json: no scan volume or request counts without the admin key', async () => {
    const customerKey = await seedFleet();
    for (const headers of [{}, { 'x-api-key': customerKey }]) {
      const body = JSON.parse((await server.inject({ method: 'GET', url: '/status.json', headers })).body);
      expect(body).not.toHaveProperty('scanStats');
      expect(body.responseTimes.length).toBeGreaterThan(0);
      for (const bucket of body.responseTimes) expect(bucket).not.toHaveProperty('count');
    }
    const admin = JSON.parse((await server.inject({ method: 'GET', url: '/status.json', headers: { 'x-api-key': ADMIN } })).body);
    expect(admin.scanStats).toMatchObject({ today: expect.any(Number) });
  });

  it('/queue/status: configuration for everyone, queue sizes for admin only', async () => {
    const customerKey = await seedFleet();
    for (const headers of [{}, { 'x-api-key': customerKey }]) {
      const body = JSON.parse((await server.inject({ method: 'GET', url: '/queue/status', headers })).body);
      expect(body.maxConcurrency).toBeGreaterThan(0);
      for (const k of ['pending', 'processing', 'completed', 'failed', 'cancelled', 'total']) expect(body).not.toHaveProperty(k);
    }
    const admin = JSON.parse((await server.inject({ method: 'GET', url: '/queue/status', headers: { 'x-api-key': ADMIN } })).body);
    expect(admin.pending).toBe(1);
  });

  it('/notifications page: no subscriber or delivery counts without the admin key', async () => {
    const customerKey = await seedFleet();
    for (const headers of [{}, { 'x-api-key': customerKey }]) {
      const html = (await server.inject({ method: 'GET', url: '/notifications', headers })).body;
      expect(html).toMatch(/Configured Keys<\/div><div class="value">—</);
      expect(html).toMatch(/Recent Delivered<\/div><div class="value">—</);
    }
    const admin = (await server.inject({ method: 'GET', url: '/notifications', headers: { 'x-api-key': ADMIN } })).body;
    expect(admin).toMatch(/Configured Keys<\/div><div class="value">0</);
  });
});
