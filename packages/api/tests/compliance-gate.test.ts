// Validates: N-161 (API compliance gate endpoint — POST /scan/compliance-gate, GET /scan/:id/compliance)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getScanStore, resetScanStore } from '../src/store/scans.js';
import type { FastifyInstance } from 'fastify';

let server: FastifyInstance;

beforeEach(() => {
  process.env.FAULTLINE_API_KEY = 'test-secret';
  resetScanStore();
  server = buildServer();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

const AUTH = { 'x-api-key': 'test-secret', 'content-type': 'application/json' };

// ── POST /scan/compliance-gate ────���──────────────────────────────────────────

describe('POST /scan/compliance-gate', () => {
  it('CG1: returns 200 with gate.pass=true for compliant text', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: AUTH,
      payload: { text: 'Water boils at 100 degrees Celsius.', provider: 'mock' },
    });
    expect(res.statusCode).toBeLessThanOrEqual(422);
    const body = JSON.parse(res.body);
    expect(body.gate).toBeDefined();
    expect(typeof body.gate.pass).toBe('boolean');
    expect(body.gate.exitCode).toBeDefined();
    expect(body.report).toBeDefined();
    expect(body.scanId).toBeDefined();
  });

  it('CG2: response includes articleEvidence in report', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: AUTH,
      payload: { text: 'The Earth orbits the Sun.', provider: 'mock' },
    });
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.report.articleEvidence)).toBe(true);
    expect(body.report.articleEvidence.length).toBeGreaterThan(0);
  });

  it('CG3: response includes gate.articles array with per-article results', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: AUTH,
      payload: { text: 'AI is safe.', provider: 'mock' },
    });
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.gate.articles)).toBe(true);
    for (const a of body.gate.articles) {
      expect(typeof a.article).toBe('string');
      expect(typeof a.status).toBe('string');
      expect(typeof a.pass).toBe('boolean');
    }
  });

  it('CG4: stores scan in ScanStore', async () => {
    const sizeBefore = getScanStore().size;
    await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: AUTH,
      payload: { text: 'Test claim for storage.', provider: 'mock' },
    });
    expect(getScanStore().size).toBe(sizeBefore + 1);
  });

  it('CG5: accepts projectName parameter', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: AUTH,
      payload: { text: 'Claim.', provider: 'mock', projectName: 'Acme AI v3' },
    });
    const body = JSON.parse(res.body);
    expect(body.report.projectName).toBe('Acme AI v3');
  });

  it('CG6: returns 401 without API key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: { 'content-type': 'application/json' },
      payload: { text: 'No auth.', provider: 'mock' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('CG7: returns 400 for empty text', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: AUTH,
      payload: { text: '', provider: 'mock' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('CG8: gate.totalArticles matches report.articleEvidence.length', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/compliance-gate',
      headers: AUTH,
      payload: { text: 'Fact check this.', provider: 'mock' },
    });
    const body = JSON.parse(res.body);
    expect(body.gate.totalArticles).toBe(body.report.articleEvidence.length);
  });
});

// ── GET /scan/:id/compliance ─────────────────────────────────────────────────

describe('GET /scan/:id/compliance', () => {
  it('CG9: returns compliance gate for existing scan', async () => {
    const stored = getScanStore().record('test-key', 'Sample text.', {
      input: 'Sample text.',
      provider: 'mock',
      claims: [{ id: 'c1', text: 'Sample text.', type: 'fact', importance: 3 }],
      verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK.', sources: [] } },
      overallRisk: 'low',
      complianceReport: {
        generatedAt: new Date().toISOString(),
        overallRiskLevel: 'low',
        euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 1, totalClaims: 1, highestTier: 'minimal' },
        claimMappings: [],
        triggeredArticles: [],
        mitigations: [],
        confidenceDistribution: { high: 1, medium: 0, low: 0 },
      },
      ruleFindings: [],
    });

    const res = await server.inject({
      method: 'GET',
      url: `/scan/${stored.id}/compliance`,
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBeLessThanOrEqual(422);
    const body = JSON.parse(res.body);
    expect(body.gate).toBeDefined();
    expect(body.report).toBeDefined();
    expect(body.scanId).toBe(stored.id);
  });

  it('CG10: returns 404 for unknown scan ID', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/scan/nonexistent-id/compliance',
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('CG11: accepts projectName query parameter', async () => {
    const stored = getScanStore().record('test-key', 'Text.', {
      input: 'Text.',
      provider: 'mock',
      claims: [],
      verifications: {},
      overallRisk: 'low',
      complianceReport: {
        generatedAt: new Date().toISOString(),
        overallRiskLevel: 'low',
        euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 0, totalClaims: 0, highestTier: 'minimal' },
        claimMappings: [],
        triggeredArticles: [],
        mitigations: [],
        confidenceDistribution: { high: 0, medium: 0, low: 0 },
      },
      ruleFindings: [],
    });

    const res = await server.inject({
      method: 'GET',
      url: `/scan/${stored.id}/compliance?projectName=TestProject`,
      headers: { 'x-api-key': 'test-secret' },
    });
    const body = JSON.parse(res.body);
    expect(body.report.projectName).toBe('TestProject');
  });

  it('CG12: returns 401 without API key', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/scan/some-id/compliance',
    });
    expect(res.statusCode).toBe(401);
  });
});
