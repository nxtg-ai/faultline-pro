/**
 * Tests for Analytics Dashboard routes (D-165)
 *
 * Covers:
 *   GET /analytics/overview  — aggregate JSON
 *   GET /analytics           — HTML dashboard
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getScanHistory, resetScanHistory } from '../src/store/scan-history.js';
import { resetCache } from '../src/store/cache.js';
import { resetClaimIndex, getClaimIndex } from '../src/store/claims.js';
import type { FastifyInstance } from 'fastify';

// ── Helpers ───────────────────────────────────────────────────────────────────

function setup() {
  resetScanHistory();
  resetCache();
  resetClaimIndex();
  process.env.FAULTLINE_API_KEY = 'test-key';
}

function seedHistory() {
  const providers = ['gemini', 'openai', 'gemini', 'claude', 'gemini'];
  const risks     = ['Low', 'Medium', 'High', 'Low', 'Critical'];
  const now = new Date().toISOString();
  providers.forEach((provider, i) => {
    getScanHistory().record({
      textHash:    `hash-${i}`,
      textPreview: `Sample text ${i}`,
      provider,
      overallRisk: risks[i],
      claimCount:  i + 2,
      latencyMs:   500 + i * 100,
      timestamp:   now,
      keyId:       'admin',
    });
  });
}

// ── GET /analytics/overview ───────────────────────────────────────────────────

describe('GET /analytics/overview', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with correct top-level shape', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.scanVolume)).toBe(true);
    expect(Array.isArray(body.providerDistribution)).toBe(true);
    expect(Array.isArray(body.riskTrend)).toBe(true);
    expect(Array.isArray(body.trustTrend)).toBe(true);
    expect(Array.isArray(body.latencyTrend)).toBe(true);
    expect(Array.isArray(body.claimCategories)).toBe(true);
    expect(typeof body.cacheStats).toBe('object');
    expect(typeof body.summary).toBe('object');
  });

  it('scanVolume has 30 entries', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    expect(body.scanVolume).toHaveLength(30);
  });

  it('scanVolume entries have date and count fields', async () => {
    seedHistory();
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    const entry = body.scanVolume[0];
    expect(typeof entry.date).toBe('string');
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof entry.count).toBe('number');
  });

  it('today bucket contains seeded entries', async () => {
    seedHistory();
    const today = new Date().toISOString().slice(0, 10);
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    const todayBucket = body.scanVolume.find((d: { date: string }) => d.date === today);
    expect(todayBucket).toBeTruthy();
    expect(todayBucket.count).toBe(5);
  });

  it('providerDistribution reflects seeded data', async () => {
    seedHistory(); // 3 gemini, 1 openai, 1 claude
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    const gemini = body.providerDistribution.find((p: { provider: string }) => p.provider === 'gemini');
    expect(gemini?.count).toBe(3);
    // sorted descending
    expect(body.providerDistribution[0].provider).toBe('gemini');
  });

  it('riskTrend has 30 entries with risk keys', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    expect(body.riskTrend).toHaveLength(30);
    const entry = body.riskTrend[0];
    expect(typeof entry.Low).toBe('number');
    expect(typeof entry.Medium).toBe('number');
    expect(typeof entry.High).toBe('number');
    expect(typeof entry.Critical).toBe('number');
  });

  it('trustTrend entries have date and avgTrustScore', async () => {
    seedHistory();
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    const today = new Date().toISOString().slice(0, 10);
    const todayEntry = body.trustTrend.find((t: { date: string }) => t.date === today);
    expect(todayEntry).toBeTruthy();
    expect(todayEntry.avgTrustScore).toBeGreaterThanOrEqual(0);
    expect(todayEntry.avgTrustScore).toBeLessThanOrEqual(100);
  });

  it('trustTrend is null for days with no data', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    // All days should have null avgTrustScore when no history
    expect(body.trustTrend.every((t: { avgTrustScore: null }) => t.avgTrustScore === null)).toBe(true);
  });

  it('latencyTrend has 30 entries', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    expect(body.latencyTrend).toHaveLength(30);
  });

  it('latencyTrend avgMs computes correctly for seeded data', async () => {
    seedHistory(); // latencyMs: 500,600,700,800,900 → avg = 700
    const today = new Date().toISOString().slice(0, 10);
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    const todayEntry = body.latencyTrend.find((t: { date: string }) => t.date === today);
    expect(todayEntry?.avgMs).toBe(700);
  });

  it('cacheStats has required fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    expect(typeof body.cacheStats.size).toBe('number');
    expect(typeof body.cacheStats.hits).toBe('number');
    expect(typeof body.cacheStats.misses).toBe('number');
    expect(typeof body.cacheStats.hitRate).toBe('number');
  });

  it('cacheStats hitRate is 0 when no cache activity', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    expect(body.cacheStats.hitRate).toBe(0);
  });

  it('claimCategories reflects ClaimIndex', async () => {
    getClaimIndex().ingest(
      [{ id: 'c1', text: 'A fact.', type: 'fact' }, { id: 'c2', text: 'An opinion.', type: 'opinion' }],
      { c1: { status: 'supported', sources: [] }, c2: { status: 'unverified', sources: [] } },
      'scan-1',
    );
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    expect(body.claimCategories.find((c: { type: string }) => c.type === 'fact')?.count).toBe(1);
    expect(body.claimCategories.find((c: { type: string }) => c.type === 'opinion')?.count).toBe(1);
  });

  it('summary has all required keys', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    const s = body.summary;
    expect(typeof s.totalScans).toBe('number');
    expect(typeof s.totalClaims).toBe('number');
    expect(typeof s.avgClaimsPerScan).toBe('number');
    expect(typeof s.mostUsedProvider).toBe('string');
    expect(typeof s.cacheHitRate).toBe('number');
    expect(typeof s.accuracyRate).toBe('number');
  });

  it('summary totalScans matches seeded count', async () => {
    seedHistory();
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    expect(body.summary.totalScans).toBe(5);
  });

  it('summary mostUsedProvider is gemini after seed', async () => {
    seedHistory();
    const res = await server.inject({ method: 'GET', url: '/analytics/overview', headers: { 'x-api-key': 'test-key' } });
    const body = JSON.parse(res.body);
    expect(body.summary.mostUsedProvider).toBe('gemini');
  });

  it('returns 401 without api key', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics/overview' });
    expect(res.statusCode).toBe(401);
  });
});

// ── GET /analytics ────────────────────────────────────────────────────────────

describe('GET /analytics', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with text/html', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics', headers: { 'x-api-key': 'test-key' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML contains Analytics heading', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics', headers: { 'x-api-key': 'test-key' } });
    expect(res.body).toContain('Analytics');
  });

  it('HTML contains Chart.js CDN reference', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics', headers: { 'x-api-key': 'test-key' } });
    expect(res.body).toContain('chart.js');
  });

  it('HTML contains scan volume chart canvas', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics', headers: { 'x-api-key': 'test-key' } });
    expect(res.body).toContain('chart-volume');
  });

  it('HTML contains trust score chart canvas', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics', headers: { 'x-api-key': 'test-key' } });
    expect(res.body).toContain('chart-trust');
  });

  it('HTML contains provider chart canvas', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics', headers: { 'x-api-key': 'test-key' } });
    expect(res.body).toContain('chart-provider');
  });

  it('HTML contains cache performance chart', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics', headers: { 'x-api-key': 'test-key' } });
    expect(res.body).toContain('chart-cache');
  });

  it('HTML contains JS fetch to /analytics/overview', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics', headers: { 'x-api-key': 'test-key' } });
    expect(res.body).toContain('/analytics/overview');
  });

  it('HTML contains summary stat cards', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics', headers: { 'x-api-key': 'test-key' } });
    expect(res.body).toContain('Total Scans');
    expect(res.body).toContain('Cache Hit Rate');
    expect(res.body).toContain('Accuracy Rate');
    expect(res.body).toContain('Top Provider');
  });

  it('returns 401 without api key', async () => {
    const res = await server.inject({ method: 'GET', url: '/analytics' });
    expect(res.statusCode).toBe(401);
  });
});
