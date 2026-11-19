import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { parseSourcePolicy, storedSourcePolicy } from '@nxtg/faultline/cli/source-policy.js';
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
// The server key is cached per forwarded user; with no user ref it gets no cache (EP4 item 7).
const adminHeaders = () => ({ 'x-api-key': ADMIN, 'content-type': 'application/json', 'x-faultline-user-ref': 'user_cachetest' });

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
    cache.set('k', 'text', 'gemini', SCAN_RESULT as unknown as Record<string, unknown>);
    return new Promise<void>(resolve => setTimeout(resolve, 5)).then(() => {
      const result = cache.get('k', 'text', 'gemini');
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

  it('changing a key source policy does not reuse a cached consensus verdict for the same claim', async () => {
    const policy = parseSourcePolicy('healthcare-authority');
    if (!policy || policy.invalid) throw new Error('healthcare-authority did not parse');
    const issued = getKeyStore().create('payer-cache', ['scan'], undefined, {
      sourcePolicy: storedSourcePolicy(policy),
    });
    const consensus = (includeDomains: string[]) => ({
      input: 'cms covers this',
      provider: 'consensus',
      claims: [{ id: 'c1', text: 'cms covers this', type: 'fact', importance: 3 }],
      verifications: {
        c1: {
          claimId: 'c1',
          status: 'supported',
          explanation: 'ok',
          sources: [{ title: 'CMS', uri: 'https://www.cms.gov/medicare', snippet: 'fee' }],
          provenance: {
            provider: 'consensus',
            model: 'openai:gpt-4o',
            retriever: 'parallel-search',
            retrievedAt: '2026-11-19T00:00:00.000Z',
            sourcePolicy: { profile: 'healthcare-authority', includeDomains },
          },
        },
      },
      overallRisk: 'low',
      complianceReport: {},
      ruleFindings: [],
    });
    mockScan.mockResolvedValue(consensus(['cms.gov', 'fda.gov', 'nih.gov', 'hhs.gov', 'ahrq.gov', 'ecfr.gov', 'federalregister.gov', 'govinfo.gov', 'congress.gov', 'cochranelibrary.com']));
    const headers = { 'x-api-key': issued.key, 'content-type': 'application/json' };
    const payload = { text: 'cms covers this', provider: 'gemini' };
    const first = await server.inject({ method: 'POST', url: '/scan', headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');
    expect(first.json().verifications.c1.provenance.provider).toBe('consensus');

    const second = await server.inject({ method: 'POST', url: '/scan', headers, payload });
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.json().verifications.c1.provenance.provider).toBe('consensus');
    expect(mockScan).toHaveBeenCalledTimes(1);

    const patched = await server.inject({
      method: 'PATCH',
      url: `/keys/${issued.id}`,
      headers: { 'x-api-key': ADMIN, 'content-type': 'application/json' },
      payload: { sourcePolicy: { includeDomains: ['fda.gov'] } },
    });
    expect(patched.statusCode).toBe(200);

    mockScan.mockResolvedValue(consensus(['fda.gov']));
    const third = await server.inject({ method: 'POST', url: '/scan', headers, payload });
    expect(third.statusCode).toBe(200);
    expect(third.headers['x-cache']).toBe('MISS');
    expect(mockScan).toHaveBeenCalledTimes(2);
    expect(third.json().verifications.c1.provenance.sourcePolicy.includeDomains).toEqual(['fda.gov']);
    expect(third.json().verifications.c1.provenance.provider).toBe('consensus');
  });
});

// Guard: a scan whose verification never ran (apiError) must NOT be cached —
// else the error report is re-served for the full TTL. Origin: 2026-07-13 prod
// free-tier-gemini 429 report cached + re-served to a paying customer.
describe('ScanCache — never caches unchecked/apiError results', () => {
  beforeEach(() => resetCache());

  it('caches a clean result (control)', () => {
    // A definite verdict needs an openable source, or the read guard serves it as unverified.
    const clean = { claims: [{ id: 'c1' }], verifications: { c1: { status: 'supported', sources: [{ title: 'S', uri: 'https://s.example' }] } } };
    getScanCache().set('k', 'doc', 'gemini', clean);
    expect(getScanCache().get('k', 'doc', 'gemini')?.result).toEqual(clean);
    expect(getScanCache().stats().size).toBe(1);
  });

  it('refuses to cache a result with an apiError verification', () => {
    const poisoned = {
      claims: [{ id: 'c1' }],
      verifications: { c1: { status: 'unverified', apiError: true, explanation: 'Verification temporarily unavailable' } },
    };
    getScanCache().set('k', 'doc429', 'gemini', poisoned);
    expect(getScanCache().get('k', 'doc429', 'gemini')).toBeNull();
    expect(getScanCache().stats().size).toBe(0);
  });

  it('refuses to cache when apiError is inline on a claim', () => {
    getScanCache().set('k', 'doc2', 'openai', { claims: [{ id: 'c1', apiError: true }] });
    expect(getScanCache().get('k', 'doc2', 'openai')).toBeNull();
  });
});

describe('ScanCache — a source policy is part of the key', () => {
  beforeEach(() => resetCache());

  const consensus = (includeDomains: string[]) => ({
    claims: [{ id: 'c1' }],
    provider: 'consensus',
    verifications: {
      c1: {
        status: 'supported',
        sources: [{ title: 'CMS', uri: 'https://www.cms.gov/medicare' }],
        provenance: {
          provider: 'consensus',
          model: 'openai:gpt-4o',
          retriever: 'parallel-search',
          sourcePolicy: { profile: 'healthcare-authority', includeDomains },
        },
      },
    },
  });

  it('does not store a consensus verdict that carries a source policy under the no-policy key', () => {
    expect(getScanCache().set('k', 'doc', 'gemini', consensus(['cms.gov']))).toBe(false);
    expect(getScanCache().get('k', 'doc', 'gemini')).toBeNull();
  });

  it('a consensus verdict cached under one policy is not served for another policy or for no policy', () => {
    const cache = getScanCache();
    const materialA = JSON.stringify({ profile: 'healthcare-authority', includeDomains: ['cms.gov'] });
    const materialB = JSON.stringify({ includeDomains: ['fda.gov'] });
    expect(cache.set('k', 'doc', 'gemini', consensus(['cms.gov']), undefined, materialA)).toBe(true);
    expect(cache.get('k', 'doc', 'gemini')).toBeNull();
    expect(cache.get('k', 'doc', 'gemini', undefined, materialB)).toBeNull();
    const hit = cache.get('k', 'doc', 'gemini', undefined, materialA);
    expect(hit?.result).toMatchObject({ provider: 'consensus' });
    expect((hit?.result as { verifications: { c1: { provenance: { provider: string } } } }).verifications.c1.provenance.provider).toBe('consensus');
  });

  it('omitting the policy keeps the previous key for a result that carries none', () => {
    const clean = { claims: [{ id: 'c1' }], verifications: { c1: { status: 'supported', sources: [{ title: 'S', uri: 'https://s.example' }] } } };
    expect(getScanCache().set('k', 'doc', 'gemini', clean)).toBe(true);
    expect(getScanCache().get('k', 'doc', 'gemini', undefined, undefined)?.result).toEqual(clean);
  });
});
