import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'x',
    provider: 'mock',
    claims: [],
    verifications: {},
    overallRisk: 'low',
    complianceReport: {},
    ruleFindings: [],
  }),
}));

vi.mock('@nxtg/faultline/cli/extract.js', () => ({
  extractTextFromBuffer: vi.fn().mockResolvedValue('x'),
}));

describe('Monitoring & Health Dashboard', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'admin-secret';
    resetAnalytics();
    resetKeyStore();
    resetAuditLogger();
    resetUsageMeter();
    resetCache();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('GET /health/deep returns 200', async () => {
    const res = await server.inject({ method: 'GET', url: '/health/deep' });
    expect(res.statusCode).toBe(200);
  });

  it('response has status field (ok or degraded)', async () => {
    const res = await server.inject({ method: 'GET', url: '/health/deep' });
    const body = JSON.parse(res.body);
    expect(['ok', 'degraded']).toContain(body.status);
  });

  it('response has timestamp as ISO string', async () => {
    const res = await server.inject({ method: 'GET', url: '/health/deep' });
    const body = JSON.parse(res.body);
    expect(typeof body.timestamp).toBe('string');
    expect(() => new Date(body.timestamp)).not.toThrow();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('subsystems.keyStore has activeKeys as number', async () => {
    const res = await server.inject({ method: 'GET', url: '/health/deep' });
    const body = JSON.parse(res.body);
    expect(body.subsystems.keyStore).toBeDefined();
    expect(typeof body.subsystems.keyStore.activeKeys).toBe('number');
  });

  it('subsystems.auditLog has entries as number', async () => {
    const res = await server.inject({ method: 'GET', url: '/health/deep' });
    const body = JSON.parse(res.body);
    expect(body.subsystems.auditLog).toBeDefined();
    expect(typeof body.subsystems.auditLog.entries).toBe('number');
  });

  it('subsystems.rateLimiter has status field', async () => {
    const res = await server.inject({ method: 'GET', url: '/health/deep' });
    const body = JSON.parse(res.body);
    expect(body.subsystems.rateLimiter).toBeDefined();
    expect(typeof body.subsystems.rateLimiter.status).toBe('string');
  });

  it('subsystems.analytics has totalScans as number', async () => {
    const res = await server.inject({ method: 'GET', url: '/health/deep' });
    const body = JSON.parse(res.body);
    expect(body.subsystems.analytics).toBeDefined();
    expect(typeof body.subsystems.analytics.totalScans).toBe('number');
  });

  it('response has providers with gemini/openai/claude/perplexity', async () => {
    const res = await server.inject({ method: 'GET', url: '/health/deep' });
    const body = JSON.parse(res.body);
    expect(body.providers).toBeDefined();
    expect(body.providers.gemini).toBeDefined();
    expect(body.providers.openai).toBeDefined();
    expect(body.providers.claude).toBeDefined();
    expect(body.providers.perplexity).toBeDefined();
  });

  it('each provider entry has configured boolean', async () => {
    const res = await server.inject({ method: 'GET', url: '/health/deep' });
    const body = JSON.parse(res.body);
    for (const provider of Object.values(body.providers) as Array<{ configured: unknown }>) {
      expect(typeof provider.configured).toBe('boolean');
    }
  });

  it('GET /metrics returns 200', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
  });

  it('metrics response has Content-Type: text/plain', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('metrics body contains faultline_scans_total', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('faultline_scans_total');
  });

  it('metrics body contains faultline_active_keys', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('faultline_active_keys');
  });

  it('metrics body contains faultline_risk_distribution', async () => {
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('faultline_risk_distribution');
  });

  it('GET /status returns 200 with Content-Type: text/html', async () => {
    const res = await server.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});
