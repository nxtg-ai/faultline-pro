import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetCache, getScanCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

const { mockScan } = vi.hoisted(() => ({ mockScan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));
vi.mock('@nxtg/faultline/cli/extract.js', () => ({ extractTextFromBuffer: vi.fn().mockResolvedValue('x') }));
// Mock compliance-report utilities — scan handler calls these after scan() resolves
vi.mock('@nxtg/faultline/cli/compliance-report.js', () => ({
  buildEuComplianceReport: vi.fn().mockReturnValue({ complianceScore: 72 }),
  evaluateComplianceGate: vi.fn().mockReturnValue({ pass: true }),
}));

const SCAN_RESULT = {
  input: 'test', provider: 'gemini',
  claims: [{ id: 'c1', text: 'test', type: 'fact', importance: 3 }],
  verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] } },
  overallRisk: 'low', complianceReport: {}, ruleFindings: [],
};

let server: FastifyInstance;
const ADMIN = 'admin';
const adminHeaders = () => ({ 'x-api-key': ADMIN, 'content-type': 'application/json' });

beforeEach(async () => {
  process.env.FAULTLINE_API_KEY = ADMIN;
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetWebhookStore();
  resetCircuitBreaker();
  resetCache();
  mockScan.mockReset();
  mockScan.mockResolvedValue(SCAN_RESULT);
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

describe('Cache — scan integration', () => {
  it('first POST /scan sets X-Cache: MISS', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('MISS');
  });

  it('first POST /scan calls mockScan once', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('second POST /scan with same text+provider sets X-Cache: HIT', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    expect(res.headers['x-cache']).toBe('HIT');
  });

  it('second POST /scan with same text+provider does not call mockScan again', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    expect(mockScan).toHaveBeenCalledTimes(1);
  });

  it('cache hit returns same overallRisk as original', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    const body = JSON.parse(res.payload);
    expect(body.overallRisk).toBe(SCAN_RESULT.overallRisk);
  });

  // CS3: Cached scan also returns complianceScore and compliancePass
  // Validates: N-200 (inline compliance score on scan response — cache-hit path)
  it('CS3: cached scan response includes complianceScore and compliancePass', async () => {
    // First request — populates cache (MISS)
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    // Second request — served from cache (HIT)
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    expect(res.headers['x-cache']).toBe('HIT');
    const body = JSON.parse(res.payload);
    expect(typeof body.complianceScore).toBe('number');
    expect(body.complianceScore).toBeGreaterThanOrEqual(0);
    expect(body.complianceScore).toBeLessThanOrEqual(100);
    expect(typeof body.compliancePass).toBe('boolean');
  });

  it('different provider is a cache miss — mockScan called again', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'openai' },
    });
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it('different text is a cache miss — mockScan called again', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'different text', provider: 'gemini' },
    });
    expect(mockScan).toHaveBeenCalledTimes(2);
  });
});

describe('Cache — admin routes', () => {
  it('GET /cache/stats returns 200 with size, hits, misses, hitRate', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/cache/stats',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveProperty('size');
    expect(body).toHaveProperty('hits');
    expect(body).toHaveProperty('misses');
    expect(body).toHaveProperty('hitRate');
  });

  it('after 1 miss + 1 hit: stats has hits=1, misses=1, hitRate=0.5', async () => {
    // miss
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    // hit
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    const res = await server.inject({
      method: 'GET',
      url: '/cache/stats',
      headers: adminHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.hits).toBe(1);
    expect(body.misses).toBe(1);
    expect(body.hitRate).toBe(0.5);
  });

  it('DELETE /cache returns 204', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/cache',
      headers: { 'x-api-key': ADMIN },
    });
    expect(res.statusCode).toBe(204);
  });

  it('after DELETE /cache, next scan is a cache miss (mockScan called again)', async () => {
    // populate cache
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    // flush
    await server.inject({
      method: 'DELETE',
      url: '/cache',
      headers: { 'x-api-key': ADMIN },
    });
    // should miss
    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'hello world', provider: 'gemini' },
    });
    expect(res.headers['x-cache']).toBe('MISS');
    expect(mockScan).toHaveBeenCalledTimes(2);
  });

  it('GET /cache/stats without admin key returns 403', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/cache/stats',
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('DELETE /cache without admin key returns 403', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/cache',
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Cache — TTL expiry', () => {
  it('expired TTL entry treated as cache miss', () => {
    process.env.FAULTLINE_CACHE_TTL_MS = '1';
    resetCache();
    const cache = getScanCache();
    cache.set('text', 'gemini', SCAN_RESULT as unknown as Record<string, unknown>);
    return new Promise<void>(resolve => setTimeout(resolve, 5)).then(() => {
      const result = cache.get('text', 'gemini');
      expect(result).toBeNull();
      delete process.env.FAULTLINE_CACHE_TTL_MS;
      resetCache();
    });
  });
});

describe('Cache — size tracking', () => {
  it('cache size in stats reflects number of distinct cached entries', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'entry one', provider: 'gemini' },
    });
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      payload: { text: 'entry two', provider: 'gemini' },
    });
    const res = await server.inject({
      method: 'GET',
      url: '/cache/stats',
      headers: adminHeaders(),
    });
    const body = JSON.parse(res.payload);
    expect(body.size).toBe(2);
  });
});

// Guard: a scan whose verification never ran (apiError) must NOT be cached —
// else the error report is re-served for the full TTL. Origin: 2026-07-13 prod
// free-tier-gemini 429 report cached + re-served to a paying customer.
describe('ScanCache — never caches unchecked/apiError results', () => {
  beforeEach(() => resetCache());

  it('caches a clean result (control)', () => {
    const clean = { claims: [{ id: 'c1' }], verifications: { c1: { status: 'supported' } } };
    getScanCache().set('doc', 'gemini', clean);
    expect(getScanCache().get('doc', 'gemini')).toEqual(clean);
    expect(getScanCache().stats().size).toBe(1);
  });

  it('refuses to cache a result with an apiError verification', () => {
    const poisoned = {
      claims: [{ id: 'c1' }],
      verifications: { c1: { status: 'unverified', apiError: true, explanation: 'Verification temporarily unavailable' } },
    };
    getScanCache().set('doc429', 'gemini', poisoned);
    expect(getScanCache().get('doc429', 'gemini')).toBeNull();
    expect(getScanCache().stats().size).toBe(0);
  });

  it('refuses to cache when apiError is inline on a claim', () => {
    getScanCache().set('doc2', 'openai', { claims: [{ id: 'c1', apiError: true }] });
    expect(getScanCache().get('doc2', 'openai')).toBeNull();
  });
});
