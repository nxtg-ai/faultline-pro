// Validates: N-217 (Art. 9 Risk Register Export)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import { getScanHistory, resetScanHistory } from '../src/store/scan-history.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  process.env.FAULTLINE_API_KEY = 'admin-secret';
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetCache();
  resetScanHistory();
}

function seedHistory() {
  const store = getScanHistory();
  store.record({ textHash: 'h1', textPreview: 'AI says the sky is green.', provider: 'mock', overallRisk: 'high', claimCount: 2, latencyMs: 100, timestamp: '2026-04-01T10:00:00.000Z', keyId: 'admin' });
  store.record({ textHash: 'h2', textPreview: 'Water boils at 100C.', provider: 'mock', overallRisk: 'low', claimCount: 1, latencyMs: 80, timestamp: '2026-04-02T10:00:00.000Z', keyId: 'admin' });
  store.record({ textHash: 'h3', textPreview: 'AI model hallucinates.', provider: 'mock', overallRisk: 'critical', claimCount: 3, latencyMs: 200, timestamp: '2026-04-03T10:00:00.000Z', keyId: 'admin' });
}

function post(server: FastifyInstance, body: object = {}) {
  return server.inject({
    method: 'POST',
    url: '/scan/risk-register',
    headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Authentication ────────────────────────────────────────────────────────────

describe('POST /scan/risk-register — authentication', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('RR1. returns 403 without API key', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan/risk-register', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.statusCode).toBe(403);
  });

  it('RR2. returns 200 with valid admin key', async () => {
    const res = await post(server);
    expect(res.statusCode).toBe(200);
  });
});

// ── Response shape ────────────────────────────────────────────────────────────

describe('POST /scan/risk-register — response shape', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('RR3. response has version, generatedAt, article, lifecyclePhase, summary, findings', async () => {
    const body = JSON.parse((await post(server)).body);
    expect(typeof body.version).toBe('string');
    expect(typeof body.generatedAt).toBe('string');
    expect(body.article).toContain('Art. 9');
    expect(typeof body.lifecyclePhase).toBe('string');
    expect(body.summary).toBeDefined();
    expect(Array.isArray(body.findings)).toBe(true);
  });

  it('RR4. summary has totalScans, riskDistribution, highRiskCount, criticalRiskCount', async () => {
    const { summary } = JSON.parse((await post(server)).body);
    expect(typeof summary.totalScans).toBe('number');
    expect(typeof summary.riskDistribution.low).toBe('number');
    expect(typeof summary.riskDistribution.high).toBe('number');
    expect(typeof summary.highRiskCount).toBe('number');
    expect(typeof summary.criticalRiskCount).toBe('number');
  });

  it('RR5. version is a UUID', async () => {
    const { version } = JSON.parse((await post(server)).body);
    expect(version).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ── Data aggregation ──────────────────────────────────────────────────────────

describe('POST /scan/risk-register — data aggregation', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); seedHistory(); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('RR6. empty store → totalScans = 0, findings = []', async () => {
    resetScanHistory();
    const body = JSON.parse((await post(server)).body);
    expect(body.summary.totalScans).toBe(0);
    expect(body.findings).toHaveLength(0);
  });

  it('RR7. 3 seeded scans → totalScans = 3, findings.length = 3', async () => {
    const body = JSON.parse((await post(server)).body);
    expect(body.summary.totalScans).toBe(3);
    expect(body.findings.length).toBe(3);
  });

  it('RR8. riskDistribution reflects seeded data (1 high, 1 low, 1 critical)', async () => {
    const { riskDistribution } = JSON.parse((await post(server)).body).summary;
    expect(riskDistribution.high).toBe(1);
    expect(riskDistribution.low).toBe(1);
    expect(riskDistribution.critical).toBe(1);
    expect(riskDistribution.medium).toBe(0);
  });

  it('RR9. highRiskCount = 1, criticalRiskCount = 1', async () => {
    const { highRiskCount, criticalRiskCount } = JSON.parse((await post(server)).body).summary;
    expect(highRiskCount).toBe(1);
    expect(criticalRiskCount).toBe(1);
  });

  it('RR10. each finding has scanId, timestamp, overallRisk, lifecyclePhase, article', async () => {
    const { findings } = JSON.parse((await post(server)).body);
    expect(findings.length).toBeGreaterThan(0);
    const f = findings[0];
    expect(typeof f.scanId).toBe('string');
    expect(typeof f.timestamp).toBe('string');
    expect(typeof f.overallRisk).toBe('string');
    expect(f.lifecyclePhase).toBe('monitoring');
    expect(f.article).toContain('Art. 9');
  });
});

// ── Lifecycle phase ───────────────────────────────────────────────────────────

describe('POST /scan/risk-register — lifecycle phase', () => {
  let server: FastifyInstance;
  beforeEach(async () => { setup(); seedHistory(); server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('RR11. default phase is "monitoring"', async () => {
    const body = JSON.parse((await post(server)).body);
    expect(body.lifecyclePhase).toBe('monitoring');
  });

  it('RR12. explicit phase "development" is reflected in response', async () => {
    const body = JSON.parse((await post(server, { phase: 'development' })).body);
    expect(body.lifecyclePhase).toBe('development');
    expect(body.findings[0]?.lifecyclePhase).toBe('development');
  });

  it('RR13. invalid phase falls back to "monitoring"', async () => {
    const body = JSON.parse((await post(server, { phase: 'invalid-phase' })).body);
    expect(body.lifecyclePhase).toBe('monitoring');
  });

  it('RR14. all valid phases accepted: testing, deployment', async () => {
    const t = JSON.parse((await post(server, { phase: 'testing' })).body);
    expect(t.lifecyclePhase).toBe('testing');
    const d = JSON.parse((await post(server, { phase: 'deployment' })).body);
    expect(d.lifecyclePhase).toBe('deployment');
  });
});
