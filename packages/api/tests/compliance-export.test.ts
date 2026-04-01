// Validates: N-198 (Compliance history export endpoint — GET /compliance/export)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getComplianceHistoryStore, resetComplianceHistoryStore } from '../src/store/compliance-history.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'Test',
    provider: 'mock',
    claims: [],
    verifications: {},
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] },
    ruleFindings: [],
  }),
}));

const AUTH = { 'x-api-key': 'test-secret' };

describe('GET /compliance/export', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'test-secret';
    resetComplianceHistoryStore();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('CE1: returns JSON by default with Content-Disposition', async () => {
    const res = await server.inject({
      method: 'GET', url: '/compliance/export',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('compliance-history');
    expect(res.headers['content-disposition']).toContain('.json');
    const body = JSON.parse(res.body);
    expect(body.entries).toBeDefined();
    expect(body.count).toBe(0);
    expect(body.exportedAt).toBeDefined();
  });

  it('CE2: JSON export includes recorded entries', async () => {
    getComplianceHistoryStore().record({
      projectName: 'export-test',
      scanId: 's1',
      complianceScore: 75,
      pass: true,
      overallRisk: 'Low',
      nonCompliantCount: 0,
      totalArticles: 8,
      threshold: 70,
    });

    const res = await server.inject({
      method: 'GET', url: '/compliance/export',
      headers: AUTH,
    });
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.entries[0].projectName).toBe('export-test');
    expect(body.entries[0].complianceScore).toBe(75);
  });

  it('CE3: CSV format returns text/csv with header row', async () => {
    getComplianceHistoryStore().record({
      projectName: 'csv-project',
      scanId: 's2',
      complianceScore: 60,
      pass: false,
      overallRisk: 'High',
      nonCompliantCount: 3,
      totalArticles: 8,
      threshold: 70,
    });

    const res = await server.inject({
      method: 'GET', url: '/compliance/export?format=csv',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('.csv');

    const lines = res.body.split('\n');
    expect(lines[0]).toContain('id,projectName,scanId');
    expect(lines.length).toBe(2); // header + 1 data row
    expect(lines[1]).toContain('csv-project');
    expect(lines[1]).toContain('60');
  });

  it('CE4: CSV escapes commas in project names', async () => {
    getComplianceHistoryStore().record({
      projectName: 'project, with comma',
      scanId: 's3',
      complianceScore: 50,
      pass: false,
      overallRisk: 'Medium',
      nonCompliantCount: 2,
      totalArticles: 8,
      threshold: 70,
    });

    const res = await server.inject({
      method: 'GET', url: '/compliance/export?format=csv',
      headers: AUTH,
    });
    const lines = res.body.split('\n');
    // Commas inside field should be quoted
    expect(lines[1]).toContain('"project, with comma"');
  });

  it('CE5: filters by projectName', async () => {
    getComplianceHistoryStore().record({
      projectName: 'alpha', scanId: 's1', complianceScore: 80,
      pass: true, overallRisk: 'Low', nonCompliantCount: 0, totalArticles: 8, threshold: 70,
    });
    getComplianceHistoryStore().record({
      projectName: 'beta', scanId: 's2', complianceScore: 40,
      pass: false, overallRisk: 'High', nonCompliantCount: 4, totalArticles: 8, threshold: 70,
    });

    const res = await server.inject({
      method: 'GET', url: '/compliance/export?projectName=alpha',
      headers: AUTH,
    });
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.entries[0].projectName).toBe('alpha');
  });

  it('CE6: returns 401 without API key', async () => {
    const res = await server.inject({ method: 'GET', url: '/compliance/export' });
    expect(res.statusCode).toBe(401);
  });

  it('CE7: empty export returns count 0', async () => {
    const res = await server.inject({
      method: 'GET', url: '/compliance/export?projectName=nonexistent',
      headers: AUTH,
    });
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(body.entries).toEqual([]);
  });

  it('CE8: CSV with multiple entries has correct line count', async () => {
    for (let i = 0; i < 5; i++) {
      getComplianceHistoryStore().record({
        projectName: 'multi', scanId: `s${i}`, complianceScore: 50 + i * 10,
        pass: i >= 2, overallRisk: 'Low', nonCompliantCount: 0, totalArticles: 8, threshold: 70,
      });
    }

    const res = await server.inject({
      method: 'GET', url: '/compliance/export?format=csv',
      headers: AUTH,
    });
    const lines = res.body.split('\n').filter(Boolean);
    expect(lines.length).toBe(6); // 1 header + 5 data rows
  });

  it('CE9: CSV content-disposition filename includes date', async () => {
    const res = await server.inject({
      method: 'GET', url: '/compliance/export?format=csv',
      headers: AUTH,
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(res.headers['content-disposition']).toContain(today);
  });

  it('CE10: since filter works in JSON export', async () => {
    getComplianceHistoryStore().record({
      projectName: 'dated', scanId: 's1', complianceScore: 90,
      pass: true, overallRisk: 'Low', nonCompliantCount: 0, totalArticles: 8, threshold: 70,
    });

    // Query with since=future should return nothing
    const res = await server.inject({
      method: 'GET', url: '/compliance/export?since=2099-01-01',
      headers: AUTH,
    });
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
  });
});
