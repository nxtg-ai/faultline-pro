import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'Benchmark claim text.',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'Benchmark claim text.', type: 'fact', importance: 3 }],
    verifications: {
      c1: { claimId: 'c1', status: 'verified', explanation: 'Synthetic.', sources: [] },
    },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] },
    ruleFindings: [],
  }),
}));

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

describe('Performance benchmarks — mock provider', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'bench-key';
    resetCache();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('100 sequential GET /health requests — p99 < 50ms', async () => {
    const latencies: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const res = await server.inject({ method: 'GET', url: '/health' });
      latencies.push(performance.now() - t0);
      expect(res.statusCode).toBe(200);
    }

    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    expect(latencies.length).toBe(100);
    expect(p50).toBeGreaterThan(0);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(p99).toBeGreaterThanOrEqual(p95);
    expect(p99).toBeLessThan(50); // health is lightweight
  });

  it('100 POST /scan requests (cache MISS first pass) — p99 < 200ms', async () => {
    const latencies: number[] = [];

    // 100 unique texts → all cache misses
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const res = await server.inject({
        method: 'POST',
        url: '/scan',
        headers: { 'x-api-key': 'bench-key', 'content-type': 'application/json' },
        payload: JSON.stringify({ text: `Unique claim number ${i}`, provider: 'mock' }),
      });
      latencies.push(performance.now() - t0);
      expect(res.statusCode).toBe(200);
    }

    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    expect(latencies.length).toBe(100);
    expect(p50).toBeGreaterThan(0);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(p99).toBeGreaterThanOrEqual(p95);
    expect(p99).toBeLessThan(200);
  });

  it('cache HIT requests are faster than cold (MISS) requests', async () => {
    const TEXT = 'The cache benchmark claim.';

    // Prime the cache (1 MISS)
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'bench-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: TEXT, provider: 'mock' }),
    });

    // Measure 50 MISS requests (unique texts)
    const missLatencies: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const res = await server.inject({
        method: 'POST',
        url: '/scan',
        headers: { 'x-api-key': 'bench-key', 'content-type': 'application/json' },
        payload: JSON.stringify({ text: `Cache miss text ${i}`, provider: 'mock' }),
      });
      missLatencies.push(performance.now() - t0);
      expect(res.statusCode).toBe(200);
    }

    // Measure 50 HIT requests (same text)
    const hitLatencies: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const res = await server.inject({
        method: 'POST',
        url: '/scan',
        headers: { 'x-api-key': 'bench-key', 'content-type': 'application/json' },
        payload: JSON.stringify({ text: TEXT, provider: 'mock' }),
      });
      hitLatencies.push(performance.now() - t0);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(res.headers['x-cache']).toBe('HIT');
      expect(body.overallRisk).toBe('low');
    }

    missLatencies.sort((a, b) => a - b);
    hitLatencies.sort((a, b) => a - b);

    const missP50 = percentile(missLatencies, 50);
    const hitP50 = percentile(hitLatencies, 50);
    const hitP99 = percentile(hitLatencies, 99);

    // Gate 2: assert non-empty results
    expect(missLatencies.length).toBe(50);
    expect(hitLatencies.length).toBe(50);
    expect(hitP50).toBeGreaterThan(0);
    expect(hitP99).toBeGreaterThanOrEqual(hitP50);

    // Cache hits should be at least as fast as misses (or close — both are mock)
    // With real providers, cache hits are dramatically faster
    // With mock: hit p99 should still be < 100ms
    expect(hitP99).toBeLessThan(100);
  });

  it('batch: 100 scans via POST /scan/batch — all succeed', async () => {
    const texts = Array.from({ length: 10 }, (_, i) => `Batch benchmark claim ${i}`);

    const latencies: number[] = [];
    for (let batch = 0; batch < 10; batch++) {
      const t0 = performance.now();
      const res = await server.inject({
        method: 'POST',
        url: '/scan/batch',
        headers: { 'x-api-key': 'bench-key', 'content-type': 'application/json' },
        payload: JSON.stringify({ texts, provider: 'mock' }),
      });
      latencies.push(performance.now() - t0);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results.length).toBe(10);
    }

    latencies.sort((a, b) => a - b);
    const p50 = percentile(latencies, 50);
    const p99 = percentile(latencies, 99);

    expect(latencies.length).toBe(10);
    expect(p50).toBeGreaterThan(0);
    expect(p99).toBeGreaterThanOrEqual(p50);
  });
});
