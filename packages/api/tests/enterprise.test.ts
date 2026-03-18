import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetAuditLogger, getAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter, getUsageMeter } from '../src/store/usage.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'GPT-4 is 92% accurate on medical diagnoses.',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'GPT-4 is 92% accurate', type: 'fact', importance: 4 }],
    verifications: {
      c1: { claimId: 'c1', status: 'unverified', explanation: 'No source found.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] },
    ruleFindings: [],
  }),
}));

function makeServer(): FastifyInstance {
  return buildServer();
}

describe('POST /keys', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-secret';
    resetKeyStore();
    resetAuditLogger();
    resetUsageMeter();
    server = makeServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('1. returns 201 with id, name, permissions, createdAt, key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'CI Runner' }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.name).toBe('CI Runner');
    expect(Array.isArray(body.permissions)).toBe(true);
    expect(body.createdAt).toBeDefined();
    expect(body.key).toBeDefined();
  });

  it('2. key secret is a 64-char hex string', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test Key' }),
    });
    const body = JSON.parse(res.body);
    expect(body.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('3. custom permissions stored correctly', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin Key', permissions: ['admin', 'scan'] }),
    });
    const body = JSON.parse(res.body);
    expect(body.permissions).toContain('admin');
    expect(body.permissions).toContain('scan');
  });

  it('4. returns 400 when name is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['scan'] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('5. returns 400 when name exceeds 100 chars', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(101) }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('6. returns 403 for non-admin keystore key', async () => {
    const scanKey = getKeyStore().create('scan-only', ['scan']);
    const res = await server.inject({
      method: 'POST',
      url: '/keys',
      headers: { 'x-api-key': scanKey.key, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Another Key' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('7. returns 403 when x-api-key header is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Key' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('8. returns 503 when no FAULTLINE_API_KEY configured and keystore empty', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const res = await server.inject({
      method: 'POST',
      url: '/keys',
      headers: { 'x-api-key': 'any', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Key' }),
    });
    expect(res.statusCode).toBe(503);
  });

  it('9. returns 400 for invalid permission enum value', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/keys',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Key', permissions: ['not-a-permission'] }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /keys', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-secret';
    resetKeyStore();
    resetAuditLogger();
    resetUsageMeter();
    server = makeServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('10. returns 200 with empty array initially', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('11. returns created key entry (Gate 2: length > 0)', async () => {
    getKeyStore().create('My Key');
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const body = JSON.parse(res.body);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].name).toBe('My Key');
  });

  it('12. key secret is NOT present in GET /keys response', async () => {
    getKeyStore().create('Secret Key');
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const body = JSON.parse(res.body);
    expect(body[0].key).toBeUndefined();
  });

  it('13. returns 403 for non-admin key', async () => {
    const scanKey = getKeyStore().create('scan-only', ['scan']);
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': scanKey.key },
    });
    expect(res.statusCode).toBe(403);
  });

  it('14. returns 503 when FAULTLINE_API_KEY is not set and keystore empty', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': 'any' },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('DELETE /keys/:id', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-secret';
    resetKeyStore();
    resetAuditLogger();
    resetUsageMeter();
    server = makeServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('15. returns 204 when deleting existing key', async () => {
    const key = getKeyStore().create('To Delete');
    const res = await server.inject({
      method: 'DELETE',
      url: `/keys/${key.id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('16. returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/keys/nonexistent-id',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('17. returns 403 for non-admin key', async () => {
    const scanKey = getKeyStore().create('scan-only', ['scan']);
    const target = getKeyStore().create('Target');
    const res = await server.inject({
      method: 'DELETE',
      url: `/keys/${target.id}`,
      headers: { 'x-api-key': scanKey.key },
    });
    expect(res.statusCode).toBe(403);
  });

  it('18. deleted key returns 401 on POST /scan', async () => {
    const key = getKeyStore().create('Temp Key', ['scan']);
    await server.inject({
      method: 'DELETE',
      url: `/keys/${key.id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': key.key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim.' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('19. GET /keys after delete shows reduced count', async () => {
    getKeyStore().create('Key A');
    const keyB = getKeyStore().create('Key B');
    await server.inject({
      method: 'DELETE',
      url: `/keys/${keyB.id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe('Key A');
  });
});

describe('Integration', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-secret';
    resetKeyStore();
    resetAuditLogger();
    resetUsageMeter();
    server = makeServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('20. created keystore key can POST /scan', async () => {
    const key = getKeyStore().create('Scanner', ['scan']);
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': key.key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('21. FAULTLINE_API_KEY still works alongside keystore keys', async () => {
    getKeyStore().create('Other Key', ['scan']);
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('22. returns 503 when env var deleted AND keystore empty', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'any', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(503);
  });

  it("23. returns 401 when key doesn't match either source", async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'wrong-key', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('24. admin-scoped keystore key can GET /keys', async () => {
    const adminKey = getKeyStore().create('Admin Key', ['admin']);
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': adminKey.key },
    });
    expect(res.statusCode).toBe(200);
  });

  it('25. scan-only keystore key gets 403 on GET /keys', async () => {
    const scanKey = getKeyStore().create('Scan Key', ['scan']);
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': scanKey.key },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /usage', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-secret';
    resetKeyStore();
    resetAuditLogger();
    resetUsageMeter();
    server = makeServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('26. GET /usage returns { keyId, usage }', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/usage',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.keyId).toBeDefined();
    expect(body.usage).toBeDefined();
  });

  it('27. usage is empty object before any scans', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/usage',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const body = JSON.parse(res.body);
    expect(body.usage).toEqual({});
  });

  it('28. POST /scan (200) increments today count (Gate 2: count > 0)', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    const today = new Date().toISOString().split('T')[0];
    const meter = getUsageMeter();
    const usage = meter.getUsage('admin');
    expect(usage[today]).toBeGreaterThan(0);
  });

  it('29. two POST /scans → usage count = 2', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'First claim.' }),
    });
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Second claim.' }),
    });
    const today = new Date().toISOString().split('T')[0];
    expect(getUsageMeter().getUsage('admin')[today]).toBe(2);
  });

  it('30. returns 401 on GET /usage with missing auth', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/usage',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Audit', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-secret';
    resetKeyStore();
    resetAuditLogger();
    resetUsageMeter();
    server = makeServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('31. POST /scan creates an audit entry (Gate 2: length > 0)', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    const entries = getAuditLogger().getEntries();
    expect(entries.length).toBeGreaterThan(0);
  });

  it('32. audit entry has correct endpoint, method, statusCode', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    const entry = getAuditLogger().getEntries().find((e) => e.endpoint === '/scan');
    expect(entry).toBeDefined();
    expect(entry!.method).toBe('POST');
    expect(entry!.statusCode).toBe(200);
  });

  it('33. audit entry has latencyMs >= 0', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    const entry = getAuditLogger().getEntries().find((e) => e.endpoint === '/scan');
    expect(entry!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('34. audit entry keyId matches the request', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    const entry = getAuditLogger().getEntries().find((e) => e.endpoint === '/scan');
    expect(entry!.keyId).toBe('admin');
  });

  it('35. POST /scan entry has inputHash (non-empty hex string)', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    const entry = getAuditLogger().getEntries().find((e) => e.endpoint === '/scan');
    expect(entry!.inputHash).toBeDefined();
    expect(entry!.inputHash).toMatch(/^[0-9a-f]+$/);
    expect(entry!.inputHash!.length).toBeGreaterThan(0);
  });

  it('36. multiple requests → multiple audit entries (exact count)', async () => {
    await server.inject({
      method: 'GET',
      url: '/health',
    });
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Claim one.' }),
    });
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Claim two.' }),
    });
    expect(getAuditLogger().getEntries().length).toBe(3);
  });
});

describe('Permissions', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-secret';
    resetKeyStore();
    resetAuditLogger();
    resetUsageMeter();
    server = makeServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it("37. key with ['admin'] → 200 on GET /keys", async () => {
    const adminKey = getKeyStore().create('Admin', ['admin']);
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': adminKey.key },
    });
    expect(res.statusCode).toBe(200);
  });

  it("38. key with ['scan'] → 403 on GET /keys", async () => {
    const scanKey = getKeyStore().create('Scanner', ['scan']);
    const res = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': scanKey.key },
    });
    expect(res.statusCode).toBe(403);
  });

  it("39. key with ['scan'] → 200 on POST /scan", async () => {
    const scanKey = getKeyStore().create('Scanner', ['scan']);
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': scanKey.key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("40. key with ['scan', 'admin'] → 200 on both", async () => {
    const dualKey = getKeyStore().create('Dual', ['scan', 'admin']);
    const scanRes = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': dualKey.key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    const keysRes = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': dualKey.key },
    });
    expect(scanRes.statusCode).toBe(200);
    expect(keysRes.statusCode).toBe(200);
  });
});
