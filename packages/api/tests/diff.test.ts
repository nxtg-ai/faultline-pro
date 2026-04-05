import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetJobStore, resetJobScheduler } from '../src/store/jobs.js';
import type { FastifyInstance } from 'fastify';

const { mockScan } = vi.hoisted(() => ({ mockScan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));
vi.mock('@nxtg/faultline/cli/extract.js', () => ({ extractTextFromBuffer: vi.fn() }));

interface Claim {
  id: string;
  text: string;
  type: string;
  importance: number;
}

function makeClaim(id: string, text: string): Claim {
  return { id, text, type: 'fact', importance: 3 };
}

function makeVerification(claimId: string, status: string) {
  return { claimId, status, explanation: 'ok', sources: [] };
}

function makeScanResult(claims: Claim[], verifications: Record<string, unknown>, risk: string) {
  return { input: 'test', provider: 'mock', claims, verifications, overallRisk: risk, complianceReport: {}, ruleFindings: [] };
}

let server: FastifyInstance;

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = 'test-key';
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetWebhookStore();
  resetCache();
  resetCircuitBreaker();
  resetJobStore();
  resetJobScheduler();
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
  vi.clearAllMocks();
});

describe('POST /scan/diff', () => {
  it('DF1: returns 200 with before/after scan results', async () => {
    const c1 = makeClaim('c1', 'Claim one');
    const resultA = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'low');
    const resultB = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'low');
    mockScan.mockResolvedValueOnce(resultA).mockResolvedValueOnce(resultB);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text version one', after: 'text version two' }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.before).toBeDefined();
    expect(body.after).toHaveProperty('claims');
  });

  it('DF2: response has newClaims, removedClaims, changedVerdicts, trustScoreDelta, summary, inlineDiff', async () => {
    const c1 = makeClaim('c1', 'Claim one');
    const resultA = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'low');
    const resultB = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'low');
    mockScan.mockResolvedValueOnce(resultA).mockResolvedValueOnce(resultB);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text version one', after: 'text version two' }),
    });

    const body = JSON.parse(res.body);
    expect(Array.isArray(body.newClaims)).toBe(true);
    expect(Array.isArray(body.removedClaims)).toBe(true);
    expect(Array.isArray(body.changedVerdicts)).toBe(true);
    expect(typeof body.trustScoreDelta).toBe('number');
    expect(typeof body.summary).toBe('string');
    expect(Array.isArray(body.inlineDiff)).toBe(true);
  });

  it('DF3: newClaims contains claims in after but not in before', async () => {
    const c1 = makeClaim('c1', 'Existing claim');
    const c2 = makeClaim('c2', 'Brand new claim');
    const resultA = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'low');
    const resultB = makeScanResult([makeClaim('c1', 'Existing claim'), c2], {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'unverified'),
    }, 'low');
    mockScan.mockResolvedValueOnce(resultA).mockResolvedValueOnce(resultB);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text before', after: 'text after' }),
    });

    const body = JSON.parse(res.body);
    expect(body.newClaims.length).toBe(1);
    expect(body.newClaims[0].text).toBe('Brand new claim');
  });

  it('DF4: removedClaims contains claims in before but not in after', async () => {
    const c1 = makeClaim('c1', 'Existing claim');
    const c2 = makeClaim('c2', 'Removed claim');
    const resultA = makeScanResult([c1, c2], {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'supported'),
    }, 'low');
    const resultB = makeScanResult([makeClaim('c1', 'Existing claim')], {
      c1: makeVerification('c1', 'supported'),
    }, 'low');
    mockScan.mockResolvedValueOnce(resultA).mockResolvedValueOnce(resultB);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text before', after: 'text after' }),
    });

    const body = JSON.parse(res.body);
    expect(body.removedClaims.length).toBe(1);
    expect(body.removedClaims[0].text).toBe('Removed claim');
  });

  it('DF5: trustScoreDelta is a number', async () => {
    const c1 = makeClaim('c1', 'Some claim');
    const resultA = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'medium');
    const resultB = makeScanResult([makeClaim('c1', 'Some claim')], { c1: makeVerification('c1', 'supported') }, 'high');
    mockScan.mockResolvedValueOnce(resultA).mockResolvedValueOnce(resultB);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text before', after: 'text after' }),
    });

    const body = JSON.parse(res.body);
    expect(typeof body.trustScoreDelta).toBe('number');
    expect(body.trustScoreDelta).toBe(1); // high(3) - medium(2) = 1
  });

  it('DF6: summary is "Risk improved", "Risk worsened", or "No change"', async () => {
    const c1 = makeClaim('c1', 'Some claim');
    const resultA = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'high');
    const resultB = makeScanResult([makeClaim('c1', 'Some claim')], { c1: makeVerification('c1', 'supported') }, 'low');
    mockScan.mockResolvedValueOnce(resultA).mockResolvedValueOnce(resultB);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text before', after: 'text after' }),
    });

    const body = JSON.parse(res.body);
    expect(['Risk improved', 'Risk worsened', 'No change']).toContain(body.summary);
    expect(body.summary).toBe('Risk improved');
  });

  it('DF7: inlineDiff entries have type and claim fields', async () => {
    const c1 = makeClaim('c1', 'Shared claim');
    const resultA = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'low');
    const resultB = makeScanResult([makeClaim('c1', 'Shared claim')], { c1: makeVerification('c1', 'supported') }, 'low');
    mockScan.mockResolvedValueOnce(resultA).mockResolvedValueOnce(resultB);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text before', after: 'text after' }),
    });

    const body = JSON.parse(res.body);
    expect(body.inlineDiff.length).toBeGreaterThan(0);
    for (const entry of body.inlineDiff) {
      expect(typeof entry.type).toBe('string');
      expect(typeof entry.claim).toBe('string');
    }
  });

  it('DF8: inlineDiff contains "added" entries for new claims', async () => {
    const c1 = makeClaim('c1', 'Old claim');
    const c2 = makeClaim('c2', 'Added claim');
    const resultA = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'low');
    const resultB = makeScanResult([makeClaim('c1', 'Old claim'), c2], {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'unverified'),
    }, 'low');
    mockScan.mockResolvedValueOnce(resultA).mockResolvedValueOnce(resultB);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text before', after: 'text after' }),
    });

    const body = JSON.parse(res.body);
    const added = body.inlineDiff.filter((e: { type: string }) => e.type === 'added');
    expect(added.length).toBe(1);
    expect(added[0].claim).toBe('Added claim');
  });

  it('DF9: inlineDiff contains "removed" entries for removed claims', async () => {
    const c1 = makeClaim('c1', 'Kept claim');
    const c2 = makeClaim('c2', 'Dropped claim');
    const resultA = makeScanResult([c1, c2], {
      c1: makeVerification('c1', 'supported'),
      c2: makeVerification('c2', 'supported'),
    }, 'low');
    const resultB = makeScanResult([makeClaim('c1', 'Kept claim')], { c1: makeVerification('c1', 'supported') }, 'low');
    mockScan.mockResolvedValueOnce(resultA).mockResolvedValueOnce(resultB);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text before', after: 'text after' }),
    });

    const body = JSON.parse(res.body);
    const removed = body.inlineDiff.filter((e: { type: string }) => e.type === 'removed');
    expect(removed.length).toBe(1);
    expect(removed[0].claim).toBe('Dropped claim');
  });

  it('DF10: POST /scan/diff requires api key — 401 without', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text one', after: 'text two' }),
    });

    expect(res.statusCode).toBe(401);
  });

  it('DF11: POST /scan/diff with provider=mock works', async () => {
    const c1 = makeClaim('c1', 'Mock claim');
    const result = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'low');
    mockScan.mockResolvedValueOnce(result).mockResolvedValueOnce(result);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff?provider=mock',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: 'text one', after: 'text two', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(200);
  });

  it('DF12: when before==after texts, newClaims and removedClaims are both empty', async () => {
    const c1 = makeClaim('c1', 'Identical claim');
    const result = makeScanResult([c1], { c1: makeVerification('c1', 'supported') }, 'low');
    mockScan.mockResolvedValueOnce(result).mockResolvedValueOnce(result);

    const sameText = 'The exact same document text.';
    const res = await server.inject({
      method: 'POST',
      url: '/scan/diff',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ before: sameText, after: sameText }),
    });

    const body = JSON.parse(res.body);
    expect(body.newClaims).toEqual([]);
    expect(body.removedClaims).toEqual([]);
  });
});
