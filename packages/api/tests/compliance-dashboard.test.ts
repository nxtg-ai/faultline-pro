// Validates: N-196 (EU AI Act Compliance HTML Dashboard — GET /compliance/dashboard)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getComplianceHistoryStore, resetComplianceHistoryStore } from '../src/store/compliance-history.js';
import type { FastifyInstance } from 'fastify';

const AUTH = { 'x-api-key': 'test-secret' };

describe('GET /compliance/dashboard', () => {
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

  it('CD1: returns 200 with text/html', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/compliance/dashboard',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('CD2: includes EU AI Act heading', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/compliance/dashboard',
      headers: AUTH,
    });
    expect(res.body).toContain('EU AI Act Compliance Dashboard');
  });

  it('CD3: shows Article 50 enforcement countdown', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/compliance/dashboard',
      headers: AUTH,
    });
    expect(res.body).toContain('Article 50 enforcement');
    expect(res.body).toMatch(/\d+ days/);
  });

  it('CD4: shows empty state when no history', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/compliance/dashboard',
      headers: AUTH,
    });
    expect(res.body).toContain('No compliance evaluations');
  });

  it('CD5: shows history entries after recording', async () => {
    getComplianceHistoryStore().record({
      projectName: 'test-project',
      scanId: 'scan-1',
      complianceScore: 85,
      pass: true,
      overallRisk: 'Low',
      nonCompliantCount: 0,
      totalArticles: 8,
      threshold: 70,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/compliance/dashboard',
      headers: AUTH,
    });
    expect(res.body).toContain('test-project');
    expect(res.body).toContain('85');
    expect(res.body).toContain('PASS');
  });

  it('CD6: shows FAIL chip for failing evaluation', async () => {
    getComplianceHistoryStore().record({
      projectName: 'failing-project',
      scanId: 'scan-2',
      complianceScore: 30,
      pass: false,
      overallRisk: 'High',
      nonCompliantCount: 3,
      totalArticles: 8,
      threshold: 70,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/compliance/dashboard',
      headers: AUTH,
    });
    expect(res.body).toContain('FAIL');
    expect(res.body).toContain('High');
  });

  it('CD7: shows pass rate percentage', async () => {
    getComplianceHistoryStore().record({
      projectName: 'p1', scanId: 's1', complianceScore: 90, pass: true,
      overallRisk: 'Low', nonCompliantCount: 0, totalArticles: 8, threshold: 70,
    });
    getComplianceHistoryStore().record({
      projectName: 'p2', scanId: 's2', complianceScore: 20, pass: false,
      overallRisk: 'Critical', nonCompliantCount: 5, totalArticles: 8, threshold: 70,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/compliance/dashboard',
      headers: AUTH,
    });
    expect(res.body).toContain('50%');
    expect(res.body).toContain('1 of 2');
  });

  it('CD8: returns 401 without API key', async () => {
    const res = await server.inject({ method: 'GET', url: '/compliance/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('CD9: auto-refreshes every 30 seconds', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/compliance/dashboard',
      headers: AUTH,
    });
    expect(res.body).toContain('content="30"');
  });

  it('CD10: XSS-safe project names', async () => {
    getComplianceHistoryStore().record({
      projectName: '<script>alert(1)</script>',
      scanId: 'scan-xss',
      complianceScore: 50,
      pass: false,
      overallRisk: 'Medium',
      nonCompliantCount: 2,
      totalArticles: 8,
      threshold: 70,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/compliance/dashboard',
      headers: AUTH,
    });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });
});
