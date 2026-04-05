import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { getNpmMetricsStore, resetNpmMetricsStore } from '../src/store/npm-metrics.js';
import type { FastifyInstance } from 'fastify';

// Prevent real network calls during tests
vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'test', provider: 'mock', claims: [], verifications: {},
    overallRisk: 'low', complianceReport: { riskTier: 'minimal', findings: [] }, ruleFindings: [],
  }),
}));

const API_KEY = 'admin-key';

beforeEach(() => {
  process.env.FAULTLINE_API_KEY = API_KEY;
  resetNpmMetricsStore();
});

// ── Store unit tests ─────────────────────────────────────────────────────────

describe('NpmMetricsStore', () => {
  it('records and retrieves package downloads', () => {
    const store = getNpmMetricsStore();
    const downloads = [
      { day: '2026-03-28', downloads: 10 },
      { day: '2026-03-29', downloads: 25 },
      { day: '2026-03-30', downloads: 15 },
    ];
    const result = store.record('@nxtg/faultline', downloads);

    expect(result.package).toBe('@nxtg/faultline');
    expect(result.totalDownloads).toBe(50);
    expect(result.downloads).toHaveLength(3);
    expect(result.lastFetched).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('get returns null for unknown package', () => {
    expect(getNpmMetricsStore().get('unknown-package')).toBeNull();
  });

  it('getOverview aggregates all packages', () => {
    const store = getNpmMetricsStore();
    store.record('@nxtg/faultline', [
      { day: '2026-03-28', downloads: 100 },
      { day: '2026-03-29', downloads: 200 },
    ]);
    store.record('@nxtg/faultline-api', [
      { day: '2026-03-28', downloads: 50 },
      { day: '2026-03-29', downloads: 75 },
    ]);

    const overview = store.getOverview();
    expect(overview.packages).toHaveLength(2);
    expect(overview.grandTotal).toBe(425);
    expect(overview.period.start).toBe('2026-03-28');
    expect(overview.period.end).toBe('2026-03-29');
    expect(overview.fetchedAt).not.toBe('never');
  });

  it('getOverview returns empty when no data', () => {
    const overview = getNpmMetricsStore().getOverview();
    expect(overview.packages).toHaveLength(0);
    expect(overview.grandTotal).toBe(0);
    expect(overview.fetchedAt).toBe('never');
  });

  it('getWeeklyTrend groups daily data into weeks', () => {
    const store = getNpmMetricsStore();
    // Generate 14 days of data
    const downloads = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.UTC(2026, 2, 16 + i)); // 2026-03-16 is a Monday
      downloads.push({ day: d.toISOString().slice(0, 10), downloads: 10 + i });
    }
    store.record('@nxtg/faultline', downloads);

    const trend = store.getWeeklyTrend('@nxtg/faultline', 4);
    expect(trend.length).toBeGreaterThanOrEqual(2);
    for (const w of trend) {
      expect(w.week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(w.downloads).toBeGreaterThan(0);
    }
  });

  it('getWeeklyTrend returns empty for unknown package', () => {
    expect(getNpmMetricsStore().getWeeklyTrend('nope')).toEqual([]);
  });

  it('trackedPackages returns expected packages', () => {
    const pkgs = getNpmMetricsStore().trackedPackages;
    expect(pkgs).toContain('@nxtg/faultline');
    expect(pkgs).toContain('@nxtg/faultline-api');
    expect(pkgs).toContain('@nxtg/faultline-sdk');
  });

  it('lastPollTime is null before any poll', () => {
    expect(getNpmMetricsStore().lastPollTime).toBeNull();
  });

  it('lastPollTime updates after record', () => {
    getNpmMetricsStore().record('test', [{ day: '2026-03-30', downloads: 1 }]);
    expect(getNpmMetricsStore().lastPollTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── Route integration tests ──────────────────────────────────────────────────

describe('GET /npm/downloads', () => {
  let server: FastifyInstance;

  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('returns 401 without API key', async () => {
    const res = await server.inject({ method: 'GET', url: '/npm/downloads' });
    expect(res.statusCode).toBe(401);
  });

  it('returns overview with 200', async () => {
    getNpmMetricsStore().record('@nxtg/faultline', [
      { day: '2026-03-30', downloads: 42 },
    ]);
    const res = await server.inject({
      method: 'GET', url: '/npm/downloads',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.packages).toHaveLength(1);
    expect(body.grandTotal).toBe(42);
  });

  it('returns empty overview when no data', async () => {
    const res = await server.inject({
      method: 'GET', url: '/npm/downloads',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.packages).toHaveLength(0);
    expect(body.grandTotal).toBe(0);
  });
});

describe('GET /npm/downloads/:package', () => {
  let server: FastifyInstance;

  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('returns 404 for unknown package', async () => {
    const res = await server.inject({
      method: 'GET', url: '/npm/downloads/unknown-pkg',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns package data with 200', async () => {
    getNpmMetricsStore().record('my-pkg', [
      { day: '2026-03-29', downloads: 10 },
      { day: '2026-03-30', downloads: 20 },
    ]);
    const res = await server.inject({
      method: 'GET', url: '/npm/downloads/my-pkg',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.package).toBe('my-pkg');
    expect(body.totalDownloads).toBe(30);
    expect(body.downloads).toHaveLength(2);
  });

  it('handles URL-encoded scoped package names', async () => {
    getNpmMetricsStore().record('@nxtg/faultline', [
      { day: '2026-03-30', downloads: 5 },
    ]);
    const res = await server.inject({
      method: 'GET', url: '/npm/downloads/%40nxtg%2Ffaultline',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).package).toBe('@nxtg/faultline');
  });
});

describe('GET /npm/trend/:package', () => {
  let server: FastifyInstance;

  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('returns weekly trend', async () => {
    const downloads = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.UTC(2026, 2, 16 + i));
      downloads.push({ day: d.toISOString().slice(0, 10), downloads: 5 });
    }
    getNpmMetricsStore().record('trend-pkg', downloads);

    const res = await server.inject({
      method: 'GET', url: '/npm/trend/trend-pkg',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.package).toBe('trend-pkg');
    expect(body.trend.length).toBeGreaterThanOrEqual(2);
  });

  it('respects weeks query parameter', async () => {
    const downloads = [];
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.UTC(2026, 2, 2 + i));
      downloads.push({ day: d.toISOString().slice(0, 10), downloads: 3 });
    }
    getNpmMetricsStore().record('weeks-pkg', downloads);

    const res = await server.inject({
      method: 'GET', url: '/npm/trend/weeks-pkg?weeks=2',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.weeks).toBe(2);
    expect(body.trend.length).toBeLessThanOrEqual(2);
  });
});

describe('POST /npm/poll', () => {
  let server: FastifyInstance;

  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('rejects non-admin requests', async () => {
    const res = await server.inject({ method: 'POST', url: '/npm/poll' });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('triggers poll and returns 200 (admin only)', async () => {
    // Mock global fetch to prevent real network calls
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        downloads: [{ day: '2026-03-30', downloads: 99 }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const res = await server.inject({
      method: 'POST', url: '/npm/poll',
      headers: { 'x-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('polled');

    vi.unstubAllGlobals();
  });
});
