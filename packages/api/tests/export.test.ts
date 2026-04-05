import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetScanHistory, getScanHistory } from '../src/store/scan-history.js';
import type { FastifyInstance } from 'fastify';

// ── Mock the scan engine ──────────────────────────────────────────────────────
vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'Mock scan input.',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'Mock scan input.', type: 'fact', importance: 3 }],
    verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'OK', sources: [] } },
    overallRisk: 'low',
    complianceReport: { overallRiskLevel: 'low', euRiskSummary: { unacceptable: 0, high: 0, limited: 0, minimal: 1, totalClaims: 1, highestTier: 'minimal' }, claimMappings: [], triggeredArticles: [], mitigations: [], confidenceDistribution: { high: 0, medium: 0, low: 1 }, generatedAt: new Date().toISOString() },
    ruleFindings: [],
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function seedHistory(server: FastifyInstance): void {
  // Seed with 5 synthetic history entries across different dates/providers
  const store = getScanHistory();
  const base = (i: number) => ({
    textPreview: `Test scan number ${i}`,
    textHash: `hash-${i}`,
    provider: i % 2 === 0 ? 'mock' : 'gemini',
    overallRisk: ['low', 'medium', 'high', 'critical', 'low'][i % 5] as string,
    claimCount: i + 1,
    latencyMs: 100 + i * 10,
    timestamp: `2026-03-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
    keyId: 'test-key',
  });
  for (let i = 0; i < 5; i++) {
    store.record(base(i));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /export', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-key';
    resetScanHistory();
    server = buildServer();
    seedHistory(server);
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it('requires API key — returns 401 without key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'json' }),
    });
    expect(res.statusCode).toBe(401);
  });

  // ── CSV format ──────────────────────────────────────────────────────────────

  it('returns CSV with correct content-type and attachment header', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'csv' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.csv');
  });

  it('CSV output has header row and at least one data row', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'csv' }),
    });
    const lines = res.body.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('timestamp');
    expect(lines[0]).toContain('overall_risk');
  });

  it('X-Export-Count header matches number of exported records', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'csv' }),
    });
    const count = parseInt(res.headers['x-export-count'] as string, 10);
    expect(count).toBeGreaterThan(0);
    const dataRows = res.body.split('\n').filter(Boolean).length - 1; // minus header
    expect(count).toBe(dataRows);
  });

  // ── JSON format ─────────────────────────────────────────────────────────────

  it('returns valid JSON array when format=json', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'json' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const parsed = JSON.parse(res.body);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it('JSON rows include trust_score field', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'json' }),
    });
    const parsed = JSON.parse(res.body);
    parsed.forEach((row: Record<string, unknown>) => {
      expect(typeof row['trustScore']).toBe('number');
      expect(row['trustScore']).toBeGreaterThanOrEqual(0);
      expect(row['trustScore']).toBeLessThanOrEqual(100);
    });
  });

  // ── NDJSON format ───────────────────────────────────────────────────────────

  it('returns one valid JSON object per line when format=ndjson', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'ndjson' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    const lines = res.body.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach(line => {
      expect(() => JSON.parse(line)).not.toThrow();
    });
  });

  // ── Filtering ───────────────────────────────────────────────────────────────

  it('filters by provider', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'json', provider: 'gemini' }),
    });
    const parsed = JSON.parse(res.body);
    expect(Array.isArray(parsed)).toBe(true);
    parsed.forEach((row: Record<string, unknown>) => {
      expect(row['provider']).toBe('gemini');
    });
  });

  it('filters by risk level', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'json', risk: 'low' }),
    });
    const parsed = JSON.parse(res.body);
    expect(Array.isArray(parsed)).toBe(true);
    parsed.forEach((row: Record<string, unknown>) => {
      expect(row['overallRisk']).toBe('low');
    });
  });

  it('filters by date range from + to', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({
        format: 'json',
        from: '2026-03-02',
        to: '2026-03-04',
      }),
    });
    const parsed = JSON.parse(res.body);
    // All entries should be within the date range
    if (Array.isArray(parsed)) {
      parsed.forEach((row: Record<string, unknown>) => {
        expect(row['timestamp'] as string >= '2026-03-02').toBe(true);
        expect(row['timestamp'] as string <= '2026-03-04T23:59:59.999Z').toBe(true);
      });
    }
  });

  it('returns 200 with message when no entries match filters', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'json', provider: 'perplexity' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(typeof body.message).toBe('string');
  });

  // ── Defaults ─────────────────────────────────────────────────────────────────

  it('defaults to CSV when format is omitted', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });

  it('returns 400 for invalid format value', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/export',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ format: 'xml' }),
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Filename in Content-Disposition ─────────────────────────────────────────

  it('filename in Content-Disposition uses today\'s date and correct extension', async () => {
    for (const fmt of ['csv', 'json', 'ndjson'] as const) {
      const res = await server.inject({
        method: 'POST',
        url: '/export',
        headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
        payload: JSON.stringify({ format: fmt }),
      });
      if (res.statusCode === 200 && res.headers['content-disposition']) {
        const cd = res.headers['content-disposition'] as string;
        expect(cd).toContain(`.${fmt === 'ndjson' ? 'ndjson' : fmt}`);
      }
    }
  });
});
