import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetAuditLogger, getAuditLogger } from '../src/store/audit.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'test',
    provider: 'mock',
    claims: [],
    verifications: {},
    overallRisk: 'low',
    complianceReport: { overallRiskLevel: 'low', euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 0, totalClaims: 0, highestTier: 'minimal' }, claimMappings: [], triggeredArticles: [], mitigations: [], confidenceDistribution: { high: 0, medium: 0, low: 0 }, generatedAt: new Date().toISOString() },
    ruleFindings: [],
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function seedAuditLog(): void {
  const logger = getAuditLogger();
  const base = new Date('2026-03-10T10:00:00.000Z').getTime();

  logger.log({ timestamp: new Date(base).toISOString(),        keyId: 'admin-key', endpoint: '/scan',         method: 'POST', statusCode: 200, latencyMs: 120 });
  logger.log({ timestamp: new Date(base + 1000).toISOString(), keyId: 'user-key',  endpoint: '/scan',         method: 'POST', statusCode: 400, latencyMs: 10  });
  logger.log({ timestamp: new Date(base + 2000).toISOString(), keyId: 'admin-key', endpoint: '/keys',         method: 'GET',  statusCode: 200, latencyMs: 5   });
  logger.log({ timestamp: new Date(base + 3000).toISOString(), keyId: 'user-key',  endpoint: '/scan/deep',    method: 'POST', statusCode: 200, latencyMs: 340 });
  logger.log({ timestamp: new Date(base + 4000).toISOString(), keyId: 'admin-key', endpoint: '/audit/log',    method: 'GET',  statusCode: 200, latencyMs: 2   });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /audit/log', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'admin-key';
    resetAuditLogger();
    server = buildServer();
    seedAuditLog();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  // AL1: requires admin key
  it('AL1: returns 403 without API key', async () => {
    const res = await server.inject({ method: 'GET', url: '/audit/log' });
    expect(res.statusCode).toBe(403);
  });

  // AL2: returns entries array
  it('AL2: returns entries array with total', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.total).toBeGreaterThan(0);
  });

  // AL3: entries are newest-first
  it('AL3: entries are ordered newest-first', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log',
      headers: { 'x-api-key': 'admin-key' },
    });
    const { entries } = JSON.parse(res.body);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].timestamp >= entries[i].timestamp).toBe(true);
    }
  });

  // AL4: filter by keyId
  it('AL4: filters by keyId', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log?keyId=user-key',
      headers: { 'x-api-key': 'admin-key' },
    });
    const { entries } = JSON.parse(res.body);
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((e: { keyId: string }) => expect(e.keyId).toBe('user-key'));
  });

  // AL5: filter by endpoint substring
  it('AL5: filters by endpoint substring', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log?endpoint=/scan',
      headers: { 'x-api-key': 'admin-key' },
    });
    const { entries } = JSON.parse(res.body);
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((e: { endpoint: string }) => expect(e.endpoint).toContain('/scan'));
  });

  // AL6: filter by HTTP method
  it('AL6: filters by method (case-insensitive)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log?method=GET',
      headers: { 'x-api-key': 'admin-key' },
    });
    const { entries } = JSON.parse(res.body);
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((e: { method: string }) => expect(e.method).toBe('GET'));
  });

  // AL7: filter by statusCode
  it('AL7: filters by statusCode', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log?statusCode=400',
      headers: { 'x-api-key': 'admin-key' },
    });
    const { entries } = JSON.parse(res.body);
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((e: { statusCode: number }) => expect(e.statusCode).toBe(400));
  });

  // AL8: filter by date range
  it('AL8: filters by from + to date range', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log?from=2026-03-10&to=2026-03-10',
      headers: { 'x-api-key': 'admin-key' },
    });
    const { entries, total } = JSON.parse(res.body);
    expect(total).toBe(5); // all 5 seeded entries are on 2026-03-10
    entries.forEach((e: { timestamp: string }) => {
      expect(e.timestamp >= '2026-03-10').toBe(true);
      expect(e.timestamp <= '2026-03-10T23:59:59.999Z').toBe(true);
    });
  });

  // AL9: limit parameter respected
  it('AL9: limit parameter caps returned entries', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log?limit=2',
      headers: { 'x-api-key': 'admin-key' },
    });
    const { entries, total, truncated } = JSON.parse(res.body);
    expect(entries.length).toBe(2);
    expect(total).toBeGreaterThan(2);
    expect(truncated).toBe(true);
  });

  // AL10: returns empty array when no entries
  it('AL10: returns empty when no entries', async () => {
    resetAuditLogger();
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log',
      headers: { 'x-api-key': 'admin-key' },
    });
    const { entries, total } = JSON.parse(res.body);
    expect(entries).toEqual([]);
    expect(total).toBe(0);
  });
});

// ── GET /audit/log/stats ──────────────────────────────────────────────────────

describe('GET /audit/log/stats', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'admin-key';
    resetAuditLogger();
    server = buildServer();
    seedAuditLog();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  // AL11: stats require admin key
  it('AL11: requires admin key', async () => {
    const res = await server.inject({ method: 'GET', url: '/audit/log/stats' });
    expect(res.statusCode).toBe(403);
  });

  // AL12: returns total, avgLatencyMs, byEndpoint, byMethod, byStatus, byKey
  it('AL12: returns summary statistics', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log/stats',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.total).toBe('number');
    expect(body.total).toBe(5);
    expect(typeof body.avgLatencyMs).toBe('number');
    expect(body.avgLatencyMs).toBeGreaterThan(0);
    expect(typeof body.byEndpoint).toBe('object');
    expect(typeof body.byMethod).toBe('object');
    expect(typeof body.byStatus).toBe('object');
    expect(typeof body.byKey).toBe('object');
  });

  // AL13: byEndpoint counts match seeded data
  it('AL13: byEndpoint counts match seeded data', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log/stats',
      headers: { 'x-api-key': 'admin-key' },
    });
    const { byEndpoint } = JSON.parse(res.body);
    // 2 entries for /scan, 1 for /keys, 1 for /scan/deep, 1 for /audit/log
    expect(byEndpoint['/scan']).toBe(2);
    expect(byEndpoint['/keys']).toBe(1);
  });
});

// ── GET /audit/log/export ─────────────────────────────────────────────────────

describe('GET /audit/log/export', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'admin-key';
    resetAuditLogger();
    server = buildServer();
    seedAuditLog();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  // AL14: export returns NDJSON content-type
  it('AL14: export returns application/x-ndjson', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log/export',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
  });

  // AL15: export has attachment Content-Disposition with .ndjson extension
  it('AL15: export Content-Disposition is attachment with .ndjson extension', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log/export',
      headers: { 'x-api-key': 'admin-key' },
    });
    const cd = res.headers['content-disposition'] as string;
    expect(cd).toContain('attachment');
    expect(cd).toContain('.ndjson');
  });

  // AL16: X-Export-Count header matches line count
  it('AL16: X-Export-Count matches number of exported lines', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log/export',
      headers: { 'x-api-key': 'admin-key' },
    });
    const count = parseInt(res.headers['x-export-count'] as string, 10);
    const lines = res.body.split('\n').filter(Boolean);
    expect(count).toBe(lines.length);
    expect(count).toBe(5);
  });

  // AL17: each exported line is valid JSON
  it('AL17: each exported line is valid JSON with required fields', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log/export',
      headers: { 'x-api-key': 'admin-key' },
    });
    const lines = res.body.split('\n').filter(Boolean);
    lines.forEach(line => {
      expect(() => JSON.parse(line)).not.toThrow();
      const obj = JSON.parse(line);
      expect(obj).toHaveProperty('timestamp');
      expect(obj).toHaveProperty('keyId');
      expect(obj).toHaveProperty('endpoint');
      expect(obj).toHaveProperty('statusCode');
      expect(obj).toHaveProperty('latencyMs');
    });
  });

  // AL18: export filter — only exports matching entries
  it('AL18: export respects filters', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log/export?keyId=admin-key',
      headers: { 'x-api-key': 'admin-key' },
    });
    const lines = res.body.split('\n').filter(Boolean);
    expect(lines.length).toBe(3); // admin-key has 3 entries
    lines.forEach(line => {
      const obj = JSON.parse(line);
      expect(obj.keyId).toBe('admin-key');
    });
  });

  // AL19: export empty returns empty body with X-Export-Count: 0
  it('AL19: export empty returns empty body', async () => {
    resetAuditLogger();
    const res = await server.inject({
      method: 'GET',
      url: '/audit/log/export',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-export-count']).toBe('0');
    expect(res.body.trim()).toBe('');
  });
});
