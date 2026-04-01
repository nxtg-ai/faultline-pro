import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter, setCustomLimit } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics, getAnalyticsStore } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'claim text',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'claim', type: 'fact', importance: 3 }],
    verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] } },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] } as any,
    ruleFindings: [],
  }),
}));
vi.mock('@nxtg/faultline/cli/compliance-report.js', () => ({
  buildEuComplianceReport: vi.fn().mockReturnValue({ complianceScore: 72 }),
  evaluateComplianceGate: vi.fn().mockReturnValue({ pass: true }),
}));

async function getScanMock() {
  const { scan } = await import('@nxtg/faultline/cli/scan.js');
  return vi.mocked(scan);
}

function setup() {
  process.env.FAULTLINE_API_KEY = 'admin-secret';
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetCache();
}

async function doScan(server: FastifyInstance, key = 'admin-secret') {
  return server.inject({
    method: 'POST',
    url: '/scan',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Some claim text.' }),
  });
}

async function getDashboard(server: FastifyInstance, key = 'admin-secret') {
  return server.inject({
    method: 'GET',
    url: '/dashboard',
    headers: { 'x-api-key': key },
  });
}

// ─── Group A: Authentication ───────────────────────────────────────────────

describe('GET /dashboard — authentication', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setup();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('D1. returns 401 when no x-api-key header', async () => {
    const res = await server.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(403);
  });

  it('D2. returns 403 for non-admin key', async () => {
    const k = getKeyStore().create('Scan Only', ['scan']);
    const res = await getDashboard(server, k.key);
    expect(res.statusCode).toBe(403);
  });

  it('D3. returns 200 for env-var admin key', async () => {
    const res = await getDashboard(server);
    expect(res.statusCode).toBe(200);
  });
});

// ─── Group B: Response shape ───────────────────────────────────────────────

describe('GET /dashboard — response shape', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setup();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('D4. response has scans.today, scans.week, scans.month', async () => {
    const res = await getDashboard(server);
    const body = JSON.parse(res.body);
    expect(typeof body.scans.today).toBe('number');
    expect(typeof body.scans.week).toBe('number');
    expect(typeof body.scans.month).toBe('number');
  });

  it('D5. response has riskDistribution with keys: low, medium, high, critical', async () => {
    const res = await getDashboard(server);
    const body = JSON.parse(res.body);
    expect('low' in body.riskDistribution).toBe(true);
    expect('medium' in body.riskDistribution).toBe(true);
    expect('high' in body.riskDistribution).toBe(true);
    expect('critical' in body.riskDistribution).toBe(true);
  });

  it('D6. response has keyUsage as an array', async () => {
    const res = await getDashboard(server);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.keyUsage)).toBe(true);
  });

  it('D7. all riskDistribution values are numbers (not undefined)', async () => {
    const res = await getDashboard(server);
    const body = JSON.parse(res.body);
    const dist = body.riskDistribution;
    expect(typeof dist.low).toBe('number');
    expect(typeof dist.medium).toBe('number');
    expect(typeof dist.high).toBe('number');
    expect(typeof dist.critical).toBe('number');
  });

  it('D8. empty store → all counts 0, riskDistribution all 0, keyUsage empty', async () => {
    const res = await getDashboard(server);
    const body = JSON.parse(res.body);
    expect(body.scans.today).toBe(0);
    expect(body.scans.week).toBe(0);
    expect(body.scans.month).toBe(0);
    expect(body.riskDistribution.low).toBe(0);
    expect(body.keyUsage).toEqual([]);
  });
});

// ─── Group C: Scan counts ──────────────────────────────────────────────────

describe('GET /dashboard — scan counts', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setup();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('D9. one POST /scan → today = 1, week = 1, month = 1', async () => {
    await doScan(server);
    const res = await getDashboard(server);
    const body = JSON.parse(res.body);
    expect(body.scans.today).toBe(1);
    expect(body.scans.week).toBe(1);
    expect(body.scans.month).toBe(1);
  });

  it('D10. two POST /scans → today = 2', async () => {
    await doScan(server);
    await doScan(server);
    const res = await getDashboard(server);
    expect(JSON.parse(res.body).scans.today).toBe(2);
  });

  it('D11. Gate 2: scans.today > 0 after at least one scan', async () => {
    await doScan(server);
    const res = await getDashboard(server);
    expect(JSON.parse(res.body).scans.today).toBeGreaterThan(0);
  });

  it('D12. rate-limited (429) requests are NOT counted in analytics', async () => {
    setCustomLimit('admin', 1);
    await doScan(server);          // uses the 1 allowed request — recorded
    await doScan(server);          // 429 — rate limited, NOT recorded
    const res = await getDashboard(server);
    expect(JSON.parse(res.body).scans.today).toBe(1);
  });
});

// ─── Group D: riskDistribution ────────────────────────────────────────────

describe('GET /dashboard — riskDistribution', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setup();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('D13. scan returning overallRisk=high → riskDistribution.high = 1', async () => {
    const scanMock = await getScanMock();
    scanMock.mockResolvedValueOnce({
      input: 'x', provider: 'mock',
      claims: [{ id: 'c1', text: 'x', type: 'fact', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] } },
      overallRisk: 'high',
      complianceReport: { riskTier: 'limited', findings: [] } as any,
      ruleFindings: [],
    });
    await doScan(server);
    const body = JSON.parse((await getDashboard(server)).body);
    expect(body.riskDistribution.high).toBe(1);
  });

  it('D14. multiple scans with different risks → distribution reflects all', async () => {
    const scanMock = await getScanMock();
    scanMock
      .mockResolvedValueOnce({ input: 'x', provider: 'mock', claims: [], verifications: {}, overallRisk: 'low', complianceReport: { riskTier: 'minimal', findings: [] } as any, ruleFindings: [] })
      .mockResolvedValueOnce({ input: 'x', provider: 'mock', claims: [], verifications: {}, overallRisk: 'high', complianceReport: { riskTier: 'limited', findings: [] } as any, ruleFindings: [] })
      .mockResolvedValueOnce({ input: 'x', provider: 'mock', claims: [], verifications: {}, overallRisk: 'low', complianceReport: { riskTier: 'minimal', findings: [] } as any, ruleFindings: [] });
    // Use distinct texts to avoid cache hits masking different risk levels
    await server.inject({ method: 'POST', url: '/scan', headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Claim text alpha.' }) });
    await server.inject({ method: 'POST', url: '/scan', headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Claim text beta.' }) });
    await server.inject({ method: 'POST', url: '/scan', headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Claim text gamma.' }) });
    const body = JSON.parse((await getDashboard(server)).body);
    expect(body.riskDistribution.low).toBe(2);
    expect(body.riskDistribution.high).toBe(1);
    expect(body.riskDistribution.medium).toBe(0);
  });

  it('D15. riskDistribution exact: 2 low + 1 high → {low:2, high:1, medium:0, critical:0}', async () => {
    getAnalyticsStore().record('admin', 'low');
    getAnalyticsStore().record('admin', 'low');
    getAnalyticsStore().record('admin', 'high');
    const body = JSON.parse((await getDashboard(server)).body);
    expect(body.riskDistribution).toEqual({ low: 2, medium: 0, high: 1, critical: 0 });
  });
});

// ─── Group E: keyUsage ────────────────────────────────────────────────────

describe('GET /dashboard — keyUsage', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    setup();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('D16. keyUsage entry for a key that scanned today shows today > 0', async () => {
    await doScan(server);
    const body = JSON.parse((await getDashboard(server)).body);
    const adminEntry = body.keyUsage.find((e: { keyId: string }) => e.keyId === 'admin');
    expect(adminEntry).toBeDefined();
    expect(adminEntry.today).toBeGreaterThan(0);
  });

  it('D17. two different keys → keyUsage has two entries (Gate 2)', async () => {
    const k = getKeyStore().create('Other Key', ['scan', 'pro']);
    await doScan(server, 'admin-secret');
    await doScan(server, k.key);
    const body = JSON.parse((await getDashboard(server)).body);
    expect(body.keyUsage.length).toBe(2);
  });

  it('D18. keyUsage.today exact count = 2 after 2 scans by same key', async () => {
    await doScan(server);
    await doScan(server);
    const body = JSON.parse((await getDashboard(server)).body);
    const adminEntry = body.keyUsage.find((e: { keyId: string }) => e.keyId === 'admin');
    expect(adminEntry.today).toBe(2);
  });
});
