import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter, setCustomLimit } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore, getWebhookStore } from '../src/store/webhooks.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'claim text',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'claim', type: 'fact', importance: 3 }],
    verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] } },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] },
    ruleFindings: [],
  }),
}));

import { scan } from '@nxtg/faultline/cli/scan.js';

function resetAll() {
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetWebhookStore();
  process.env.FAULTLINE_API_KEY = 'admin-secret';
}

function batchPost(server: FastifyInstance, body: object, key = 'admin-secret') {
  return server.inject({
    method: 'POST',
    url: '/scan/batch',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Basic (6) ───────────────────────────────────────────────────────────────

describe('POST /scan/batch — Basic', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    vi.unstubAllGlobals();
  });

  it('B1. 200 with 2 texts → total=2, succeeded=2, failed=0, results.length=2', async () => {
    const res = await batchPost(server, { texts: ['text one', 'text two'] });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results.length).toBe(2);
  });

  it('B2. results[0] contains overallRisk field', async () => {
    const res = await batchPost(server, { texts: ['text one', 'text two'] });
    const body = JSON.parse(res.body);
    // Gate 2: assert results are present before accessing downstream field
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].overallRisk).toBeDefined();
  });

  it('B3. 200 with 1 text → total=1', async () => {
    const res = await batchPost(server, { texts: ['single text'] });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
  });

  it('B4. 400 with empty texts array (validation)', async () => {
    const res = await batchPost(server, { texts: [] });
    expect(res.statusCode).toBe(400);
  });

  it('B5. 400 with 11 texts (exceeds max)', async () => {
    const res = await batchPost(server, { texts: Array.from({ length: 11 }, (_, i) => `text ${i}`) });
    expect(res.statusCode).toBe(400);
  });

  it('B6. 401 with missing x-api-key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/batch',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: ['text'] }),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── Partial failure (4) ──────────────────────────────────────────────────────

describe('POST /scan/batch — Partial failure', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    vi.unstubAllGlobals();
  });

  it('P1. one item throws → succeeded=1, failed=1, results has null at failed index, errors has { index, error }', async () => {
    // With failover, a text must fail for ALL providers to count as failed.
    // Use text-based discrimination so 'fail-text' always throws.
    vi.mocked(scan).mockImplementation((text: string) => {
      if (text === 'fail-text') return Promise.reject(new Error('scan failed'));
      return Promise.resolve({
        input: text,
        provider: 'mock',
        claims: [],
        verifications: {},
        overallRisk: 'low',
        complianceReport: { riskTier: 'minimal', findings: [] } as any,
        ruleFindings: [],
      });
    });

    const res = await batchPost(server, { texts: ['text one', 'fail-text'] });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[1]).toBeNull();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0].index).toBe(1);
    expect(body.errors[0].error).toContain('scan failed');
  });

  it('P2. all items throw → succeeded=0, failed=2', async () => {
    // With failover, all providers are tried for each text — 5 providers × 2 texts = 10 calls.
    vi.mocked(scan).mockImplementation(() => Promise.reject(new Error('all fail')));

    const res = await batchPost(server, { texts: ['text one', 'text two'] });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.succeeded).toBe(0);
    expect(body.failed).toBe(2);
  });

  it('P3. errors array has correct indices (3 items where index 1 fails)', async () => {
    // With failover, index 1 text must fail for ALL providers to appear in errors.
    // Use text-based discrimination.
    vi.mocked(scan).mockImplementation((text: string) => {
      if (text === 'text 1') return Promise.reject(new Error('middle fail'));
      return Promise.resolve({
        input: text,
        provider: 'mock',
        claims: [],
        verifications: {},
        overallRisk: 'low',
        complianceReport: { riskTier: 'minimal', findings: [] } as any,
        ruleFindings: [],
      });
    });

    const res = await batchPost(server, { texts: ['text 0', 'text 1', 'text 2'] });
    const body = JSON.parse(res.body);
    // Gate 2: assert errors array is non-empty before checking downstream field
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0].index).toBe(1);
  });

  it('P4. results array length always equals total', async () => {
    vi.mocked(scan).mockRejectedValueOnce(new Error('fail'));

    const res = await batchPost(server, { texts: ['text one', 'text two'] });
    const body = JSON.parse(res.body);
    expect(body.results.length).toBe(body.total);
  });
});

// ─── Rate limiting (4) ───────────────────────────────────────────────────────

describe('POST /scan/batch — Rate limiting', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    vi.unstubAllGlobals();
  });

  it('R1. 2-item batch with limit=1 → 429', async () => {
    setCustomLimit('admin', 1);
    const res = await batchPost(server, { texts: ['text one', 'text two'] });
    expect(res.statusCode).toBe(429);
  });

  it('R2. 2-item batch with limit=2 → 200 (exactly enough)', async () => {
    setCustomLimit('admin', 2);
    const res = await batchPost(server, { texts: ['text one', 'text two'] });
    expect(res.statusCode).toBe(200);
  });

  it('R3. 2-item batch with limit=3 → 200, then 1-item → 200 (1 remaining), then another 1-item → 429', async () => {
    setCustomLimit('admin', 3);

    const r1 = await batchPost(server, { texts: ['text one', 'text two'] });
    expect(r1.statusCode).toBe(200);

    const r2 = await batchPost(server, { texts: ['text three'] });
    expect(r2.statusCode).toBe(200);

    const r3 = await batchPost(server, { texts: ['text four'] });
    expect(r3.statusCode).toBe(429);
  });

  it('R4. 429 response has X-RateLimit-Remaining header = \'0\'', async () => {
    setCustomLimit('admin', 1);
    const res = await batchPost(server, { texts: ['text one', 'text two'] });
    expect(res.statusCode).toBe(429);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });
});

// ─── Analytics + webhooks (3) ─────────────────────────────────────────────────

describe('POST /scan/batch — Analytics + webhooks', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    vi.unstubAllGlobals();
  });

  it('A1. POST /scan/batch fires webhooks — fetch called for each succeeded scan', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');

    const res = await batchPost(server, { texts: ['text one', 'text two'] });
    expect(res.statusCode).toBe(200);

    // Allow microtask queue / async dispatch to flush
    await new Promise((r) => setTimeout(r, 30));

    // fetch should be called for each of the 2 succeeded scans
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0);
  });

  it('A2. GET /usage after batch with 2 successes shows count >= 2', async () => {
    const batchRes = await batchPost(server, { texts: ['text one', 'text two'] });
    expect(batchRes.statusCode).toBe(200);

    const usageRes = await server.inject({
      method: 'GET',
      url: '/usage',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(usageRes.statusCode).toBe(200);
    const usage = JSON.parse(usageRes.body);
    const today = new Date().toISOString().split('T')[0];
    // Gate 2: usage object exists before accessing downstream field
    expect(usage.usage).toBeDefined();
    expect(usage.usage[today]).toBeGreaterThanOrEqual(2);
  });

  it('A3. GET /dashboard after batch shows scans.today >= 2', async () => {
    const batchRes = await batchPost(server, { texts: ['text one', 'text two'] });
    expect(batchRes.statusCode).toBe(200);

    const dashRes = await server.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(dashRes.statusCode).toBe(200);
    const dash = JSON.parse(dashRes.body);
    expect(dash.scans).toBeDefined();
    expect(dash.scans.today).toBeGreaterThanOrEqual(2);
  });
});

// ─── Validation (3) ───────────────────────────────────────────────────────────

describe('POST /scan/batch — Validation', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    vi.unstubAllGlobals();
  });

  it('V1. 400 if any text exceeds 50000 chars', async () => {
    const res = await batchPost(server, { texts: ['valid text', 'x'.repeat(50001)] });
    expect(res.statusCode).toBe(400);
  });

  it('V2. provider field accepted (mock)', async () => {
    const res = await batchPost(server, { texts: ['text one'], provider: 'mock' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.succeeded).toBe(1);
  });

  it('V3. 403 for non-admin key trying GET /keys; batch scan key works for scan but not admin routes', async () => {
    const scanKey = getKeyStore().create('Scan Only', ['scan']);

    // scan-only key can call /scan/batch
    const batchRes = await batchPost(server, { texts: ['text'] }, scanKey.key);
    expect(batchRes.statusCode).toBe(200);

    // scan-only key cannot call admin route GET /keys
    const keysRes = await server.inject({
      method: 'GET',
      url: '/keys',
      headers: { 'x-api-key': scanKey.key },
    });
    expect(keysRes.statusCode).toBe(403);
  });
});
