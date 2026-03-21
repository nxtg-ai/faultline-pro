/**
 * N-97 — Scan usage analytics (GET /scans/usage)
 *
 * KSU1–KSU5   ScanHistoryStore unit: getScanUsageStats() derived fields
 * KSU6–KSU15  HTTP: GET /scans/usage summary + scenarios
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getScanHistory, resetScanHistory, hashText } from '../src/store/scan-history.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import type { FastifyInstance } from 'fastify';

const API_KEY = 'api-key-scan-usage-test';

function authHeader(): Record<string, string> {
  return { 'x-api-key': API_KEY };
}

function addScan(text: string, opts: {
  daysAgo?: number;
  provider?: string;
  risk?: string;
  latencyMs?: number;
} = {}): void {
  getScanHistory().record({
    textHash:    hashText(text),
    textPreview: text.slice(0, 100),
    provider:    opts.provider   ?? 'mock',
    overallRisk: opts.risk       ?? 'Low',
    claimCount:  2,
    latencyMs:   opts.latencyMs  ?? 50,
    timestamp:   new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000).toISOString(),
    keyId:       'k1',
  });
}

// ── Store unit tests ─────────────────────────────────────────────────────────

describe('ScanHistoryStore — getScanUsageStats()', () => {
  beforeEach(() => resetScanHistory());

  it('KSU1: empty history → empty stats array', () => {
    expect(getScanHistory().getScanUsageStats()).toHaveLength(0);
  });

  it('KSU2: single scan — all fields populated correctly', () => {
    addScan('Test claim text', { daysAgo: 5, provider: 'gemini', risk: 'High', latencyMs: 120 });
    const [s] = getScanHistory().getScanUsageStats();
    expect(s.textHash).toBe(hashText('Test claim text'));
    expect(s.scanCount).toBe(1);
    expect(s.latestRisk).toBe('High');
    expect(s.riskDrifted).toBe(false);
    expect(s.providers).toEqual(['gemini']);
    expect(s.avgLatencyMs).toBe(120);
    expect(s.daysSinceLastScan).toBeGreaterThanOrEqual(5);
    expect(s.isStale).toBe(false); // 5 days < 30d default
  });

  it('KSU3: same text scanned with different risks → riskDrifted:true', () => {
    addScan('Drifting text', { daysAgo: 10, risk: 'Low' });
    addScan('Drifting text', { daysAgo: 0,  risk: 'High' });
    const [s] = getScanHistory().getScanUsageStats();
    expect(s.scanCount).toBe(2);
    expect(s.riskDrifted).toBe(true);
    expect(s.latestRisk).toBe('High');
  });

  it('KSU4: two distinct texts → two separate stat entries', () => {
    addScan('Doc alpha');
    addScan('Doc beta');
    expect(getScanHistory().getScanUsageStats()).toHaveLength(2);
  });

  it('KSU5: scan older than staleDays → isStale:true', () => {
    addScan('Old doc', { daysAgo: 31 });
    const [s] = getScanHistory().getScanUsageStats(30);
    expect(s.isStale).toBe(true);
    expect(s.daysSinceLastScan).toBeGreaterThanOrEqual(31);
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('GET /scans/usage — HTTP', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = API_KEY;
    resetKeyStore();
    resetScanHistory();
    resetAuditLogger();
    resetAnalytics();
    resetCache();
    resetCircuitBreaker();
    getKeyStore().create('Usage-Test Key');
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('KSU6: empty history → 200 with total:0 and empty stats', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/usage', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
    expect(body.stats).toHaveLength(0);
    expect(body.staleDays).toBe(30);
  });

  it('KSU7: summary fields — total, staleCount, riskDriftedCount present', async () => {
    addScan('Some text');
    const res = await server.inject({ method: 'GET', url: '/scans/usage', headers: authHeader() });
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('staleCount');
    expect(body).toHaveProperty('riskDriftedCount');
  });

  it('KSU8: stale scan counted in staleCount', async () => {
    addScan('Old text', { daysAgo: 31 });
    addScan('Fresh text', { daysAgo: 0 });

    const res = await server.inject({ method: 'GET', url: '/scans/usage', headers: authHeader() });
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.staleCount).toBe(1);
  });

  it('KSU9: risk-drifted scan counted in riskDriftedCount', async () => {
    addScan('Drift doc', { risk: 'Low',  daysAgo: 5 });
    addScan('Drift doc', { risk: 'High', daysAgo: 0 });

    const res = await server.inject({ method: 'GET', url: '/scans/usage', headers: authHeader() });
    const body = JSON.parse(res.body);
    expect(body.riskDriftedCount).toBe(1);
    expect(body.stats[0].riskDrifted).toBe(true);
  });

  it('KSU10: ?staleDays=7 — uses 7-day threshold for isStale flag', async () => {
    addScan('Week old', { daysAgo: 8 });

    const res = await server.inject({ method: 'GET', url: '/scans/usage?staleDays=7', headers: authHeader() });
    const body = JSON.parse(res.body);
    expect(body.staleDays).toBe(7);
    expect(body.stats[0].isStale).toBe(true);
    expect(body.staleCount).toBe(1);
  });

  it('KSU11: providers array contains all distinct providers used', async () => {
    addScan('Multi-provider', { provider: 'gemini',     daysAgo: 5 });
    addScan('Multi-provider', { provider: 'openai',     daysAgo: 3 });
    addScan('Multi-provider', { provider: 'gemini',     daysAgo: 0 }); // duplicate

    const res = await server.inject({ method: 'GET', url: '/scans/usage', headers: authHeader() });
    const stat = JSON.parse(res.body).stats[0];
    expect(stat.scanCount).toBe(3);
    expect(stat.providers).toHaveLength(2);
    expect(stat.providers).toContain('gemini');
    expect(stat.providers).toContain('openai');
  });

  it('KSU12: avgLatencyMs is average of all scans for that text', async () => {
    addScan('Latency doc', { latencyMs: 100, daysAgo: 1 });
    addScan('Latency doc', { latencyMs: 200, daysAgo: 0 });

    const res = await server.inject({ method: 'GET', url: '/scans/usage', headers: authHeader() });
    expect(JSON.parse(res.body).stats[0].avgLatencyMs).toBe(150);
  });

  it('KSU13: 401 without api key', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/usage' });
    expect(res.statusCode).toBe(401);
  });

  it('KSU14: staleDays clamped to 365 maximum', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/usage?staleDays=99999', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).staleDays).toBe(365);
  });

  it('KSU15: stats sorted most-recently-scanned first', async () => {
    addScan('Old doc',    { daysAgo: 10 });
    addScan('Recent doc', { daysAgo: 1  });

    const res = await server.inject({ method: 'GET', url: '/scans/usage', headers: authHeader() });
    const stats = JSON.parse(res.body).stats;
    expect(stats[0].textPreview).toContain('Recent doc');
    expect(stats[1].textPreview).toContain('Old doc');
  });
});
