/**
 * Tests for Mission Control system health dashboard (D-168)
 *
 * Covers:
 *   GET /mission-control/status — aggregate JSON
 *   GET /mission-control        — HTML dashboard
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getScanHistory, resetScanHistory } from '../src/store/scan-history.js';
import { resetCache } from '../src/store/cache.js';
import { resetAuditLogger } from '../src/store/audit.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetScanHistory();
  resetCache();
  resetAuditLogger();
  process.env.FAULTLINE_API_KEY = 'test-secret';
}

function seedHistory() {
  const providers = ['gemini', 'openai', 'gemini', 'claude', 'gemini'];
  const risks = ['Low', 'Medium', 'High', 'Low', 'Critical'];
  const now = new Date().toISOString();
  providers.forEach((provider, i) => {
    getScanHistory().record({
      textHash: `hash-${i}`,
      textPreview: `Sample ${i}`,
      provider,
      overallRisk: risks[i],
      claimCount: i + 1,
      latencyMs: 200 + i * 50,
      timestamp: now,
      keyId: 'admin',
    });
  });
}

// ── GET /mission-control/status ───────────────────────────────────────────────

describe('GET /mission-control/status', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    expect(res.statusCode).toBe(200);
  });

  it('returns 403 without api key (admin-gated)', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status' });
    expect(res.statusCode).toBe(403);
  });

  it('has correct top-level shape', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(typeof body.timestamp).toBe('string');
    expect(['healthy', 'warning', 'degraded']).toContain(body.system);
    expect(typeof body.latency).toBe('object');
    expect(Array.isArray(body.providers)).toBe(true);
    expect(typeof body.providerSummary).toBe('object');
    expect(typeof body.cache).toBe('object');
    expect(typeof body.queue).toBe('object');
    expect(typeof body.keys).toBe('object');
    expect(typeof body.scans).toBe('object');
  });

  it('latency has required fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(typeof body.latency.avg).toBe('number');
    expect(typeof body.latency.p50).toBe('number');
    expect(typeof body.latency.p95).toBe('number');
    expect(typeof body.latency.requestsLast60s).toBe('number');
    expect(typeof body.latency.requestsLast5min).toBe('number');
  });

  it('cache has required fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(typeof body.cache.size).toBe('number');
    expect(typeof body.cache.hits).toBe('number');
    expect(typeof body.cache.misses).toBe('number');
    expect(typeof body.cache.hitRate).toBe('number');
  });

  it('hitRate is 0 when no cache activity', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(body.cache.hitRate).toBe(0);
  });

  it('queue has required fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(typeof body.queue.pending).toBe('number');
    expect(typeof body.queue.processing).toBe('number');
    expect(typeof body.queue.completed).toBe('number');
    expect(typeof body.queue.failed).toBe('number');
  });

  it('queue pending is 0 initially', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(body.queue.pending).toBe(0);
  });

  it('keys has active and total fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(typeof body.keys.active).toBe('number');
    expect(typeof body.keys.total).toBe('number');
  });

  it('scans has required fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(typeof body.scans.today).toBe('number');
    expect(typeof body.scans.last60s).toBe('number');
    expect(typeof body.scans.last5min).toBe('number');
    expect(typeof body.scans.riskCounts).toBe('object');
  });

  it('scans.riskCounts has Low/Medium/High/Critical keys', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(typeof body.scans.riskCounts.Low).toBe('number');
    expect(typeof body.scans.riskCounts.Medium).toBe('number');
    expect(typeof body.scans.riskCounts.High).toBe('number');
    expect(typeof body.scans.riskCounts.Critical).toBe('number');
  });

  it('scans.today reflects seeded history', async () => {
    seedHistory();
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(body.scans.today).toBe(5);
  });

  it('scans.last60s reflects seeded history', async () => {
    seedHistory();
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(body.scans.last60s).toBe(5);
  });

  it('providerSummary has healthy and total fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(typeof body.providerSummary.healthy).toBe('number');
    expect(typeof body.providerSummary.total).toBe('number');
  });

  it('provider entries have name, status, healthScore, avgLatency, errorRate', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    // providers may be empty or populated depending on registry init
    // if populated, check shape
    if (body.providers.length > 0) {
      const p = body.providers[0];
      expect(typeof p.name).toBe('string');
      expect(['healthy', 'degraded', 'unhealthy', 'disabled']).toContain(p.status);
      expect(typeof p.healthScore).toBe('number');
      expect(typeof p.avgLatency).toBe('number');
      expect(typeof p.errorRate).toBe('number');
    } else {
      expect(body.providers).toEqual([]);
    }
  });

  it('timestamp is ISO 8601', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('system is healthy when no issues', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status', headers: { 'x-api-key': 'test-secret' } });
    const body = JSON.parse(res.body);
    // With empty queue and no providers, system should be healthy
    expect(body.system).toBe('healthy');
  });
});

// ── GET /mission-control (HTML) ───────────────────────────────────────────────

describe('GET /mission-control', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.statusCode).toBe(200);
  });

  it('returns text/html content-type', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('returns 403 without api key (admin-gated)', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control' });
    expect(res.statusCode).toBe(403);
  });

  it('contains Mission Control title', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('Mission Control');
  });

  it('contains Faultline Pro branding', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('Faultline Pro');
  });

  it('references auto-refresh 10s', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('10');
    expect(res.body).toContain('refresh');
  });

  it('contains KPI cards', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('Scans Today');
    expect(res.body).toContain('Active Keys');
    expect(res.body).toContain('Queue Depth');
    expect(res.body).toContain('Cache Hit Rate');
    expect(res.body).toContain('Avg Latency');
    expect(res.body).toContain('Providers OK');
  });

  it('contains Provider Health section', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('Provider Health');
    expect(res.body).toContain('prov-grid');
  });

  it('contains Cache subsystem panel', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('cache-stats');
  });

  it('contains Queue subsystem panel', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('queue-stats');
  });

  it('contains Risk Distribution panel', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('Risk Distribution');
    expect(res.body).toContain('risk-dist');
  });

  it('contains API Latency section', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('API Latency');
    expect(res.body).toContain('Response Time');
    expect(res.body).toContain('Throughput');
  });

  it('fetches /mission-control/status via JS', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('/mission-control/status');
  });

  it('contains auto-refresh setInterval', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('setInterval');
    expect(res.body).toContain('10_000');
  });

  it('contains system status pill element', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('sys-pill');
  });

  it('contains progress bar for refresh indicator', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control', headers: { 'x-api-key': 'test-secret' } });
    expect(res.body).toContain('refresh-bar');
    expect(res.body).toContain('refresh-progress');
  });
});
