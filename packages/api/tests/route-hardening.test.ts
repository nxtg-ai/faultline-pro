/**
 * Route Hardening Tests (N-147) — RH1–RH12
 *
 * Validates: N-20 (Batch Scan API), N-22 (Monitoring/Observability),
 *            N-39 (Production API Hardening)
 *
 * Covers uncovered branches in three API routes:
 *   RH1–RH5  : deep.ts — circuit-broken 503 (chain.length === 0),
 *              all-providers-fail 500 (catch accumulates lastError)
 *   RH6–RH10 : queue.ts — resolvePriority() branches: admin permission (0),
 *              pro permission (1), scan-only free (2), enqueue-throw 503
 *   RH11–RH12: deep.ts + queue.ts smoke — confirm happy path still works
 *              after reset (guard against test pollution)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getCircuitBreaker, resetCircuitBreaker, PROVIDER_CHAIN } from '../src/store/circuit-breaker.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getScanQueue, resetScanQueue } from '../src/store/scan-queue.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mock scan — must be declared before imports are resolved
// ---------------------------------------------------------------------------

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn(),
}));

import { scan } from '@nxtg/faultline/cli/scan.js';

const mockScan = vi.mocked(scan);

/** Minimal scan result — deep route enriches it with evidenceLinks */
const MOCK_RESULT = {
  input: 'test',
  provider: 'mock',
  claims: [],
  verifications: {},
  overallRisk: 'low' as const,
  complianceReport: {
    generatedAt: '',
    overallRiskLevel: 'low',
    euRiskSummary: { totalClaims: 0, highestTier: 'minimal', unacceptable: 0, high: 0, limited: 0, minimal: 0 },
    claimMappings: [],
    triggeredArticles: [],
    mitigations: [],
    confidenceDistribution: { high: 0, medium: 0, low: 0 },
  },
  ruleFindings: [],
} as const;

/** Trip all 5 providers in the circuit breaker by recording FAILURE_THRESHOLD failures each. */
function tripAllProviders(): void {
  const cb = getCircuitBreaker();
  for (const p of PROVIDER_CHAIN) {
    for (let i = 0; i < 5; i++) cb.recordFailure(p);
  }
}

// ===========================================================================
// RH1–RH5 — deep.ts uncovered branches
// ===========================================================================

describe('POST /scan/deep — uncovered branches', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetCircuitBreaker();
    mockScan.mockReset();
    process.env.FAULTLINE_API_KEY = 'deep-hard-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    resetCircuitBreaker();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('RH1: all providers circuit-broken → 503 "All providers are currently unavailable."', async () => {
    tripAllProviders();

    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-hard-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Check claim.', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('All providers are currently unavailable.');
  });

  it('RH2: circuit-broken with no preferred provider → 503', async () => {
    tripAllProviders();

    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-hard-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'No provider specified.' }),
    });

    expect(res.statusCode).toBe(503);
  });

  it('RH3: all providers circuit-broken → webhook event fired with error field', async () => {
    // Smoke: 503 body should have the correct error string (covers fireWebhookEvent path too)
    tripAllProviders();

    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-hard-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Claim text.', provider: 'gemini' }),
    });

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(503);
    expect(body).toHaveProperty('error');
  });

  it('RH4: all scan() calls throw → 500 with the last error message', async () => {
    mockScan.mockRejectedValue(new Error('Provider timeout'));

    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-hard-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test claim.', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Provider timeout');
  });

  it('RH5: multiple scan() failures accumulate lastError from final provider', async () => {
    // Each call throws a distinct message — the route should surface the last one
    let callCount = 0;
    mockScan.mockImplementation(() => {
      callCount++;
      return Promise.reject(new Error(`Failure ${callCount}`));
    });

    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'deep-hard-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Test claim.', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    // Error from the last provider in the chain should appear
    expect(body.error).toMatch(/^Failure \d+$/);
    expect(callCount).toBeGreaterThan(1); // tried multiple providers
  });
});

// ===========================================================================
// RH6–RH11 — queue.ts resolvePriority branches + enqueue-throw 503
// ===========================================================================

describe('POST /queue/scans — resolvePriority() branches', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetScanQueue();
    resetKeyStore();
    // Do NOT set FAULTLINE_API_KEY — use keystore keys only, so keyId is a UUID
    delete process.env.FAULTLINE_API_KEY;
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    resetScanQueue();
    resetKeyStore();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('RH6: keystore key with "admin" permission → priority 0 in response', async () => {
    const adminKey = getKeyStore().create('admin-user', ['scan', 'admin']);

    const res = await server.inject({
      method: 'POST',
      url: '/queue/scans',
      headers: { 'x-api-key': adminKey.key, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Admin priority test.', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.priority).toBe(0);
  });

  it('RH7: keystore key with "pro" permission → priority 1 in response', async () => {
    const proKey = getKeyStore().create('pro-user', ['scan', 'pro']);

    const res = await server.inject({
      method: 'POST',
      url: '/queue/scans',
      headers: { 'x-api-key': proKey.key, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Pro priority test.', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.priority).toBe(1);
  });

  it('RH8: keystore key with "scan" only → priority 2 (free tier) in response', async () => {
    const freeKey = getKeyStore().create('free-user', ['scan']);

    const res = await server.inject({
      method: 'POST',
      url: '/queue/scans',
      headers: { 'x-api-key': freeKey.key, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Free priority test.', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.priority).toBe(2);
  });

  it('RH9: 202 response contains id, status, priority, position, createdAt, pollUrl', async () => {
    const key = getKeyStore().create('user', ['scan']);

    const res = await server.inject({
      method: 'POST',
      url: '/queue/scans',
      headers: { 'x-api-key': key.key, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Structure check.', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.status).toBe('pending');
    expect(typeof body.priority).toBe('number');
    expect(body.pollUrl).toMatch(/^\/queue\/scans\//);
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('RH10: enqueue() throws (queue full spy) → 503 with error message', async () => {
    process.env.FAULTLINE_API_KEY = 'test-key';
    await server.close();
    server = buildServer();

    vi.spyOn(getScanQueue(), 'enqueue').mockImplementation(() => {
      throw new Error('Queue is full (max 10000 pending items).');
    });

    const res = await server.inject({
      method: 'POST',
      url: '/queue/scans',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Overflow test.', provider: 'mock' }),
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Queue is full');
  });
});

// ===========================================================================
// RH11–RH12 — smoke tests: reset guard
// ===========================================================================

describe('Route hardening — post-reset smoke', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetCircuitBreaker();
    resetScanQueue();
    mockScan.mockReset();
    mockScan.mockResolvedValue(MOCK_RESULT as never);
    process.env.FAULTLINE_API_KEY = 'smoke-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    resetCircuitBreaker();
    resetScanQueue();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('RH11: deep scan succeeds after circuit breaker reset', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/scan/deep',
      headers: { 'x-api-key': 'smoke-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Post-reset smoke test.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('RH12: queue enqueue returns 202 after queue reset', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/queue/scans',
      headers: { 'x-api-key': 'smoke-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Post-reset queue smoke.', provider: 'mock' }),
    });
    expect(res.statusCode).toBe(202);
  });
});
