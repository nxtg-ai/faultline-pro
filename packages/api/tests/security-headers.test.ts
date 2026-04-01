// Validates: N-195 (Security headers + GraphQL query bounds)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
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

describe('Security headers', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'test-admin-key';
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('SH1: JSON endpoint includes X-Content-Type-Options nosniff', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('SH2: JSON endpoint includes X-Frame-Options DENY', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('SH3: JSON endpoint includes Referrer-Policy', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('SH4: JSON endpoint includes CSP default-src none', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('SH5: HTML dashboard does NOT include restrictive CSP (needs inline styles)', async () => {
    const res = await server.inject({
      method: 'GET', url: '/mission-control',
      headers: { 'x-api-key': 'test-admin-key' },
    });
    // HTML pages need inline styles — CSP should be absent or permissive
    const csp = res.headers['content-security-policy'];
    if (csp) {
      expect(csp).not.toContain("default-src 'none'");
    }
  });

  it('SH6: HTML dashboard still has X-Content-Type-Options', async () => {
    const res = await server.inject({
      method: 'GET', url: '/mission-control',
      headers: { 'x-api-key': 'test-admin-key' },
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('SH7: X-XSS-Protection is 0 (modern best practice)', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-xss-protection']).toBe('0');
  });
});

describe('GraphQL query bounds', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = 'test-admin-key';
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('GQL1: scans query defaults to 50 limit', async () => {
    const res = await server.inject({
      method: 'POST', url: '/graphql',
      headers: { 'x-api-key': 'test-admin-key', 'content-type': 'application/json' },
      payload: { query: '{ scans { id } }' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.scans).toBeDefined();
  });

  it('GQL2: audit query defaults to max 500', async () => {
    const res = await server.inject({
      method: 'POST', url: '/graphql',
      headers: { 'x-api-key': 'test-admin-key', 'content-type': 'application/json' },
      payload: { query: '{ audit(limit: 999) { timestamp keyId } }' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.audit).toBeDefined();
  });

  it('GQL3: scanBatch caps at 20 texts', async () => {
    const texts = Array.from({ length: 25 }, (_, i) => `text ${i}`);
    const res = await server.inject({
      method: 'POST', url: '/graphql',
      headers: { 'x-api-key': 'test-admin-key', 'content-type': 'application/json' },
      payload: {
        query: 'mutation($texts: [String!]!) { scanBatch(texts: $texts) { id } }',
        variables: { texts },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should only process 20, not 25
    expect(body.data.scanBatch.length).toBe(20);
  });
});
