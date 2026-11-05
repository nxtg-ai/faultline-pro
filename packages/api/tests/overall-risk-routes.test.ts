/**
 * Every API route that returns overallRisk from a scan applies the engine's rule:
 * an unverified claim means its risk was not checked, never that it is low.
 *
 * Validates: the risk rule in packages/cli/lib/overall-risk.ts through POST /scan,
 * GET and POST /scan/stream, POST /scan/deep and POST /scan/batch, on the stock
 * mock provider. The mock cites no source, so each of its verdicts reads unverified.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';

const KEY = 'overall-risk-routes-key';
const TEXT = 'The Eiffel Tower is in Paris. Water boils at 100 degrees Celsius at sea level.';
const headers = { 'x-api-key': KEY, 'content-type': 'application/json' };

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
}

function expectAllUnverified(verifications: Record<string, { status: string }>): void {
  const statuses = Object.values(verifications).map((v) => v.status);
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses.every((s) => s === 'unverified')).toBe(true);
}

describe('API routes: an all-unverified scan is high risk, never low', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = KEY;
    resetKeyStore();
    resetRateLimiter();
    resetUsageMeter();
    resetCache();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('POST /scan', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan', headers, payload: JSON.stringify({ text: TEXT, provider: 'mock' }) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expectAllUnverified(body.verifications);
    expect(body.overallRisk).toBe('high');
  });

  it('GET /scan/stream', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/scan/stream?text=${encodeURIComponent(TEXT)}&provider=mock`,
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    const verified = events.filter((e) => e.type === 'claim_verified');
    expect(verified.length).toBeGreaterThan(0);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.overallRisk).toBe('high');
  });

  it('POST /scan/stream', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan/stream', headers, payload: JSON.stringify({ text: TEXT, provider: 'mock' }) });
    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    const verified = events.filter((e) => e.type === 'claim_verified');
    expect(verified.length).toBeGreaterThan(0);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.overallRisk).toBe('high');
  });

  it('POST /scan/deep', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan/deep', headers, payload: JSON.stringify({ text: TEXT, provider: 'mock' }) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expectAllUnverified(body.verifications);
    expect(body.overallRisk).toBe('high');
  });

  it('POST /scan/batch', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan/batch', headers, payload: JSON.stringify({ texts: [TEXT, TEXT], provider: 'mock' }) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toHaveLength(2);
    for (const r of body.results) {
      expect(r.overallRisk).toBe('high');
    }
  });
});
