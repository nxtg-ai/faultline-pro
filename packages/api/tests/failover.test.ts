import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger, getAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetWebhookStore } from '../src/store/webhooks.js';
import { resetCircuitBreaker, getCircuitBreaker, PROVIDER_CHAIN } from '../src/store/circuit-breaker.js';
import type { Provider } from '../src/store/circuit-breaker.js';
import { resetCache } from '../src/store/cache.js';
import { API_DOI_CHECK } from '../src/lib/evidence.js';
import type { FastifyInstance } from 'fastify';

const { mockScan } = vi.hoisted(() => ({ mockScan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));
vi.mock('@nxtg/faultline/cli/compliance-report.js', () => ({
  buildEuComplianceReport: vi.fn().mockReturnValue({ complianceScore: 72 }),
  evaluateComplianceGate: vi.fn().mockReturnValue({ pass: true }),
}));
vi.mock('@nxtg/faultline/cli/extract.js', () => ({ extractTextFromBuffer: vi.fn().mockResolvedValue('x') }));

const GOOD_RESULT = {
  input: 'test',
  provider: 'openai',
  claims: [{ id: 'c1', text: 'test', type: 'fact', importance: 3 }],
  verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: [] } },
  overallRisk: 'low',
  complianceReport: {},
  ruleFindings: [],
};

let server: FastifyInstance;
const ADMIN = 'admin-key';
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
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
});

// ─── Circuit Breaker Unit Tests ───────────────────────────────────────────────

describe('CircuitBreaker — unit', () => {
  it('isDown() returns false initially for any provider', () => {
    const cb = getCircuitBreaker();
    for (const p of PROVIDER_CHAIN) {
      expect(cb.isDown(p)).toBe(false);
    }
  });

  it('recordFailure() 4 times — isDown() still false (below threshold)', () => {
    const cb = getCircuitBreaker();
    for (let i = 0; i < 4; i++) {
      cb.recordFailure('gemini');
    }
    expect(cb.isDown('gemini')).toBe(false);
  });

  it('recordFailure() 5 times — isDown() returns true', () => {
    const cb = getCircuitBreaker();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('gemini');
    }
    expect(cb.isDown('gemini')).toBe(true);
  });

  it('recordSuccess() resets consecutive failures', () => {
    const cb = getCircuitBreaker();
    for (let i = 0; i < 4; i++) {
      cb.recordFailure('openai');
    }
    cb.recordSuccess('openai');
    expect(cb.isDown('openai')).toBe(false);
    // Verify consecutive failures reset — one more failure shouldn't trip breaker
    cb.recordFailure('openai');
    expect(cb.isDown('openai')).toBe(false);
  });

  it('getChain() without preferred returns the real providers, never the mock fallback (4 providers)', () => {
    const cb = getCircuitBreaker();
    const chain = cb.getChain();
    expect(chain).toHaveLength(4);
    expect(chain).toEqual(PROVIDER_CHAIN.filter((p) => p !== 'mock'));
    expect(chain).not.toContain('mock');
  });

  it('getChain() skips DOWN providers', () => {
    const cb = getCircuitBreaker();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('gemini');
    }
    const chain = cb.getChain();
    expect(chain).not.toContain('gemini');
    expect(chain).toHaveLength(3);
  });

  it('getChain() with preferred puts preferred first', () => {
    const cb = getCircuitBreaker();
    const chain = cb.getChain('claude');
    expect(chain[0]).toBe('claude');
    expect(chain).toHaveLength(4);
    expect(chain).not.toContain('mock');
  });

  it('getChain(\'mock\') tries mock only because it was asked for, first', () => {
    const cb = getCircuitBreaker();
    const chain = cb.getChain('mock');
    expect(chain[0]).toBe('mock');
    expect(chain.filter((p) => p === 'mock')).toHaveLength(1);
    expect(chain).toHaveLength(5);
  });

  it('getScanRoute() is Gemini alone when no provider is named', () => {
    expect(getCircuitBreaker().getScanRoute()).toEqual(['gemini']);
  });

  it('getScanRoute() is the named provider alone, never a fallback list', () => {
    expect(getCircuitBreaker().getScanRoute('claude')).toEqual(['claude']);
    expect(getCircuitBreaker().getScanRoute('mock')).toEqual(['mock']);
  });

  it('getScanRoute() is empty when that provider is DOWN, even with others up', () => {
    const cb = getCircuitBreaker();
    for (let i = 0; i < 5; i++) cb.recordFailure('gemini');
    expect(cb.getScanRoute()).toEqual([]);
    expect(cb.getScanRoute('gemini')).toEqual([]);
    expect(cb.getScanRoute('openai')).toEqual(['openai']);
  });

  it('getStatus() returns all 5 providers with their state', () => {
    const cb = getCircuitBreaker();
    cb.recordFailure('perplexity');
    const status = cb.getStatus();
    expect(Object.keys(status)).toHaveLength(5);
    for (const p of PROVIDER_CHAIN) {
      expect(status[p]).toBeDefined();
      expect(typeof status[p].down).toBe('boolean');
      expect(typeof status[p].consecutiveFailures).toBe('number');
    }
    expect(status['perplexity'].consecutiveFailures).toBe(1);
    expect(status['perplexity'].down).toBe(false);
  });
});

// ─── Integration Tests ────────────────────────────────────────────────────────

describe('Failover — integration', () => {
  it('POST /scan with working mock → 200, no failover', async () => {
    mockScan.mockResolvedValue(GOOD_RESULT);

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      body: JSON.stringify({ text: 'test', provider: 'gemini' }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.overallRisk).toBe('low');
  });

  it('POST /scan where the provider rejects once → 500, and no other provider is tried', async () => {
    let callCount = 0;
    mockScan.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('gemini unavailable'));
      return Promise.resolve(GOOD_RESULT);
    });

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      body: JSON.stringify({ text: 'test', provider: 'gemini' }),
    });

    expect(res.statusCode).toBe(500);
    expect(callCount).toBe(1);
    expect(mockScan.mock.calls.map(c => c[1])).toEqual(['gemini']);
  });

  it('a failed scan writes no /scan/failover audit entry and never reaches OpenAI or Claude', async () => {
    mockScan.mockRejectedValueOnce(new Error('gemini unavailable')).mockResolvedValue(GOOD_RESULT);

    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      body: JSON.stringify({ text: 'test' }),
    });

    const entries = getAuditLogger().getEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.find(e => e.endpoint === '/scan/failover')).toBeUndefined();
    const providers = mockScan.mock.calls.map(c => c[1]);
    expect(providers).toEqual(['gemini']);
    expect(providers).not.toContain('openai');
    expect(providers).not.toContain('claude');
  });

  it('POST /scan where all providers fail → 500', async () => {
    mockScan.mockRejectedValue(new Error('provider down'));

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      body: JSON.stringify({ text: 'test' }),
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(typeof body.error).toBe('string');
  });

  it('POST /scan with Gemini circuit-broken → 503, and the text goes to no other provider', async () => {
    const cb = getCircuitBreaker();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('gemini');
    }
    expect(cb.isDown('gemini')).toBe(true);
    mockScan.mockResolvedValue(GOOD_RESULT);

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      body: JSON.stringify({ text: 'test', provider: 'gemini' }),
    });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe('The scan provider is currently unavailable. Please retry later.');
    expect(mockScan).not.toHaveBeenCalled();
  });

  it('Circuit breaker: after 5 failures, provider marked down', async () => {
    const cb = getCircuitBreaker();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('openai');
    }
    expect(cb.isDown('openai')).toBe(true);
    expect(cb.getStatus()['openai'].down).toBe(true);
  });

  it('a caller who names a provider gets that provider while Gemini is circuit-broken', async () => {
    const cb = getCircuitBreaker();
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('gemini');
    }
    mockScan.mockResolvedValue(GOOD_RESULT);

    const res = await server.inject({
      method: 'POST',
      url: '/scan',
      headers: adminHeaders(),
      body: JSON.stringify({ text: 'test', provider: 'claude' }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(mockScan).toHaveBeenCalledWith('test', 'claude', undefined, undefined, undefined, undefined, undefined, { verifyCap: 8, doi: API_DOI_CHECK });
  });

  it('POST /scan/batch with working scan → 200', async () => {
    mockScan.mockResolvedValue(GOOD_RESULT);

    const res = await server.inject({
      method: 'POST',
      url: '/scan/batch',
      headers: adminHeaders(),
      body: JSON.stringify({ texts: ['text1', 'text2'], provider: 'mock' }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
  });

  it('POST /scan/batch partial failure (one throws, others succeed) → 200 with errors array', async () => {
    mockScan.mockImplementation((text: string) => {
      if (text === 'always-fail') return Promise.reject(new Error('provider error'));
      return Promise.resolve(GOOD_RESULT);
    });

    const res = await server.inject({
      method: 'POST',
      url: '/scan/batch',
      headers: adminHeaders(),
      body: JSON.stringify({ texts: ['always-fail', 'text2'] }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.errors).toBeInstanceOf(Array);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.succeeded).toBe(1);
  });

  it('POST /scan/batch: a text whose provider fails is not retried on another provider', async () => {
    mockScan.mockImplementation((text: string, provider: string) => {
      if (text === 'gemini-fails' && provider === 'gemini') return Promise.reject(new Error('gemini error'));
      return Promise.resolve(GOOD_RESULT);
    });

    const res = await server.inject({
      method: 'POST',
      url: '/scan/batch',
      headers: adminHeaders(),
      body: JSON.stringify({ texts: ['gemini-fails', 'text2'] }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    const failedCalls = mockScan.mock.calls.filter(c => c[0] === 'gemini-fails').map(c => c[1]);
    expect(failedCalls).toEqual(['gemini']);
  });

  it('getStatus() reflects correct down state after failures', async () => {
    const cb = getCircuitBreaker();

    // Record 5 failures for mock provider
    for (let i = 0; i < 5; i++) {
      cb.recordFailure('mock');
    }

    const status = cb.getStatus();
    expect(status['mock'].down).toBe(true);
    expect(status['mock'].consecutiveFailures).toBe(5);
    // Others should still be up
    expect(status['gemini'].down).toBe(false);
    expect(status['openai'].down).toBe(false);
  });
});
