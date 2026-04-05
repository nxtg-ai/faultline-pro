import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import { setUrlFetcher, resetUrlFetcher } from '../src/lib/url-validator.js';
import type { FastifyInstance } from 'fastify';

const MOCK_SCAN_WITH_SOURCES = vi.hoisted(() => ({
  input: 'GPT-4 achieves 90% accuracy on medical diagnoses.',
  provider: 'mock',
  claims: [
    { id: 'c1', text: 'GPT-4 achieves 90% accuracy on medical diagnoses.', type: 'fact', importance: 4 },
    { id: 'c2', text: 'This is better than human doctors.', type: 'interpretation', importance: 3 },
  ],
  verifications: {
    c1: {
      claimId: 'c1',
      status: 'unverified',
      explanation: 'Needs verification.',
      sources: [
        { title: 'GPT-4 Medical Accuracy Study', uri: 'https://example.com/study1' },
        { title: 'AI in Healthcare Review', uri: 'https://example.com/review' },
      ],
    },
    c2: {
      claimId: 'c2',
      status: 'unverified',
      explanation: 'Contested claim.',
      sources: [],
    },
  },
  overallRisk: 'medium',
  complianceReport: { riskTier: 'elevated', findings: [] },
  ruleFindings: [],
}));

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue(MOCK_SCAN_WITH_SOURCES),
}));

describe('POST /scan/deep', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'deep-test-key';
    resetCache();
    // Mock URL fetcher — returns 200 for /study1, 404 for /review
    setUrlFetcher(async (uri: string) => {
      if (uri.includes('study1')) {
        return { status: 200, headers: { 'last-modified': new Date().toISOString() } };
      }
      if (uri.includes('review')) {
        return { status: 404, headers: {} };
      }
      return { status: 0, headers: {} };
    });
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    resetUrlFetcher();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns 200 with evidenceLinks', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'GPT-4 achieves 90% accuracy.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.evidenceLinks).toBeDefined();
    expect(Array.isArray(body.evidenceLinks)).toBe(true);
    expect(body.evidenceLinks.length).toBeGreaterThan(0);
  });

  it('evidenceLinks contains one entry per claim', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'GPT-4 test.', provider: 'mock' }),
    });
    const body = JSON.parse(res.body);
    expect(body.evidenceLinks.length).toBe(2); // c1 and c2
  });

  it('c1 has source validations with evidenceScore', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'GPT-4 test.', provider: 'mock' }),
    });
    const body = JSON.parse(res.body);
    const c1Link = body.evidenceLinks.find((l: { claimId: string }) => l.claimId === 'c1');
    expect(c1Link).toBeDefined();
    expect(c1Link.sources.length).toBe(2);
    expect(typeof c1Link.overallEvidenceScore).toBe('number');
    expect(c1Link.overallEvidenceScore).toBeGreaterThanOrEqual(0);
    expect(c1Link.overallEvidenceScore).toBeLessThanOrEqual(100);
  });

  it('available source has higher evidenceScore than unavailable', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'GPT-4 test.', provider: 'mock' }),
    });
    const body = JSON.parse(res.body);
    const c1Link = body.evidenceLinks.find((l: { claimId: string }) => l.claimId === 'c1');
    const study1 = c1Link.sources.find((s: { uri: string }) => s.uri.includes('study1'));
    const review = c1Link.sources.find((s: { uri: string }) => s.uri.includes('review'));
    expect(study1.available).toBe(true);
    expect(review.available).toBe(false);
    expect(study1.evidenceScore).toBeGreaterThan(review.evidenceScore);
  });

  it('c2 has zero sources and overallEvidenceScore of 0', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'GPT-4 test.', provider: 'mock' }),
    });
    const body = JSON.parse(res.body);
    const c2Link = body.evidenceLinks.find((l: { claimId: string }) => l.claimId === 'c2');
    expect(c2Link.sources).toEqual([]);
    expect(c2Link.overallEvidenceScore).toBe(0);
  });

  it('returns base scan fields alongside evidenceLinks', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'GPT-4 test.', provider: 'mock' }),
    });
    const body = JSON.parse(res.body);
    expect(body.overallRisk).toBe('medium');
    expect(Array.isArray(body.claims)).toBe(true);
    expect(body.claims.length).toBeGreaterThan(0);
    expect(body.complianceReport).toHaveProperty('riskTier');
  });

  it('requires API key — returns 401 without key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test.' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for missing text', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ provider: 'mock' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('caches deep scan result on second request', async () => {
    const payload = JSON.stringify({ text: 'Cached deep scan claim.', provider: 'mock' });
    const headers = { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' };

    const res1 = await server.inject({ method: 'POST', url: '/scan/deep', headers, payload });
    const res2 = await server.inject({ method: 'POST', url: '/scan/deep', headers, payload });

    expect(res1.headers['x-cache']).toBe('MISS');
    expect(res2.headers['x-cache']).toBe('HIT');
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(Array.isArray(body2.evidenceLinks)).toBe(true);
  });

  it('each source has uri, title, available, statusCode, evidenceScore fields', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'GPT-4 test.', provider: 'mock' }),
    });
    const body = JSON.parse(res.body);
    const c1Link = body.evidenceLinks.find((l: { claimId: string }) => l.claimId === 'c1');
    const src = c1Link.sources[0];
    expect(src.uri).toBeTruthy();
    expect(src.title).toBeTruthy();
    expect(typeof src.available).toBe('boolean');
    expect(typeof src.statusCode).toBe('number');
    expect(typeof src.evidenceScore).toBe('number');
  });

  it('statusCode is 200 for available source', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'GPT-4 test.', provider: 'mock' }),
    });
    const body = JSON.parse(res.body);
    const c1Link = body.evidenceLinks.find((l: { claimId: string }) => l.claimId === 'c1');
    const study1 = c1Link.sources.find((s: { uri: string }) => s.uri.includes('study1'));
    expect(study1.statusCode).toBe(200);
  });

  it('overallEvidenceScore for c1 is between 0 and 100', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'GPT-4 test.', provider: 'mock' }),
    });
    const body = JSON.parse(res.body);
    const c1Link = body.evidenceLinks.find((l: { claimId: string }) => l.claimId === 'c1');
    expect(c1Link.overallEvidenceScore).toBeGreaterThanOrEqual(0);
    expect(c1Link.overallEvidenceScore).toBeLessThanOrEqual(100);
  });
});
