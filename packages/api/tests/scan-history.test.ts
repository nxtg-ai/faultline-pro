import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetScanHistory, getScanHistory } from '../src/store/scan-history.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

const SCAN_RESULT = {
  input: 'The moon landing occurred in 1969.',
  provider: 'mock',
  claims: [
    { id: 'c1', text: 'The moon landing occurred in 1969.', type: 'fact', importance: 5 },
    { id: 'c2', text: 'Neil Armstrong walked on the moon.', type: 'fact', importance: 5 },
  ],
  verifications: {
    c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [] },
    c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [] },
  },
  overallRisk: 'low',
  complianceReport: { riskTier: 'minimal', findings: [] },
  ruleFindings: [],
};

const { scan: mockScan } = vi.hoisted(() => ({ scan: vi.fn() }));

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));

describe('ScanHistory — integration tests', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-key';
    resetScanHistory();
    resetAnalytics();
    resetCircuitBreaker();
    resetCache();
    mockScan.mockResolvedValue(SCAN_RESULT);
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  // SH1: POST /scan records a scan entry in history
  it('SH1: POST /scan records a scan entry in history', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'The moon landing occurred in 1969.', provider: 'mock' }),
    });

    const history = getScanHistory();
    expect(history.size).toBeGreaterThan(0);
    const recent = history.getRecent(1);
    expect(recent.length).toBe(1);
    expect(recent[0].provider).toBe('mock');
    expect(recent[0].overallRisk).toBe('low');
    expect(recent[0].claimCount).toBe(2);
    expect(recent[0].textPreview).toContain('moon landing');
    expect(recent[0].id).toBeTruthy();
  });

  // SH2: GET /dashboard includes scanFeed array
  it('SH2: GET /dashboard includes scanFeed array', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.scanFeed)).toBe(true);
  });

  // SH3: GET /dashboard scanFeed has last 10 scans max
  it('SH3: GET /dashboard scanFeed has last 10 scans max', async () => {
    // Insert 15 entries directly into store
    const store = getScanHistory();
    for (let i = 0; i < 15; i++) {
      store.record({
        textPreview: `scan text ${i}`,
        textHash: `hash-${i}`,
        provider: 'mock',
        overallRisk: 'low',
        claimCount: 1,
        latencyMs: 100,
        timestamp: new Date().toISOString(),
        keyId: 'test-key',
      });
    }

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scanFeed.length).toBeLessThanOrEqual(10);
  });

  // SH4: GET /dashboard includes providerStatus with keys: gemini/openai/claude/perplexity/mock
  it('SH4: GET /dashboard includes providerStatus with expected keys', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.providerStatus).toBeDefined();
    expect('gemini' in body.providerStatus).toBe(true);
    expect('openai' in body.providerStatus).toBe(true);
    expect('claude' in body.providerStatus).toBe(true);
    expect('perplexity' in body.providerStatus).toBe(true);
    expect('mock' in body.providerStatus).toBe(true);
  });

  // SH5: GET /dashboard includes activeKeys integer
  it('SH5: GET /dashboard includes activeKeys integer', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.activeKeys).toBe('number');
  });

  // SH6: GET /scans/search returns scans + nextCursor + total
  it('SH6: GET /scans/search returns scans + nextCursor + total', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/scans/search',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.scans)).toBe(true);
    expect('nextCursor' in body).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  // SH7: GET /scans/search?q= filters by text preview
  it('SH7: GET /scans/search?q= filters by text preview', async () => {
    const store = getScanHistory();
    store.record({ textPreview: 'moon landing facts', textHash: 'hash-moon', provider: 'mock', overallRisk: 'low', claimCount: 1, latencyMs: 100, timestamp: new Date().toISOString(), keyId: 'k1' });
    store.record({ textPreview: 'weather forecast data', textHash: 'hash-weather', provider: 'mock', overallRisk: 'low', claimCount: 1, latencyMs: 100, timestamp: new Date().toISOString(), keyId: 'k2' });

    const res = await server.inject({ method: 'GET', url: '/scans/search?q=moon' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scans.length).toBeGreaterThan(0);
    expect(body.scans.every((s: { textPreview: string }) => s.textPreview.toLowerCase().includes('moon'))).toBe(true);
  });

  // SH8: GET /scans/search?provider= filters by provider
  it('SH8: GET /scans/search?provider= filters by provider', async () => {
    const store = getScanHistory();
    store.record({ textPreview: 'gemini scan text', textHash: 'hash-gemini', provider: 'gemini', overallRisk: 'low', claimCount: 1, latencyMs: 100, timestamp: new Date().toISOString(), keyId: 'k1' });
    store.record({ textPreview: 'openai scan text', textHash: 'hash-openai', provider: 'openai', overallRisk: 'low', claimCount: 1, latencyMs: 100, timestamp: new Date().toISOString(), keyId: 'k2' });

    const res = await server.inject({ method: 'GET', url: '/scans/search?provider=gemini' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scans.length).toBeGreaterThan(0);
    expect(body.scans.every((s: { provider: string }) => s.provider === 'gemini')).toBe(true);
  });

  // SH9: GET /scans/search?risk= filters by risk level
  it('SH9: GET /scans/search?risk= filters by risk level', async () => {
    const store = getScanHistory();
    store.record({ textPreview: 'high risk content', textHash: 'hash-high', provider: 'mock', overallRisk: 'high', claimCount: 2, latencyMs: 100, timestamp: new Date().toISOString(), keyId: 'k1' });
    store.record({ textPreview: 'low risk content', textHash: 'hash-low', provider: 'mock', overallRisk: 'low', claimCount: 1, latencyMs: 100, timestamp: new Date().toISOString(), keyId: 'k2' });

    const res = await server.inject({ method: 'GET', url: '/scans/search?risk=high' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scans.length).toBeGreaterThan(0);
    expect(body.scans.every((s: { overallRisk: string }) => s.overallRisk === 'high')).toBe(true);
  });

  // SH10: GET /scans/search cursor pagination — nextCursor is set when more pages exist
  it('SH10: nextCursor is set when more pages exist', async () => {
    const store = getScanHistory();
    for (let i = 0; i < 5; i++) {
      store.record({ textPreview: `entry ${i}`, textHash: `hash-entry-${i}`, provider: 'mock', overallRisk: 'low', claimCount: 1, latencyMs: 100, timestamp: new Date().toISOString(), keyId: 'k' });
    }

    const res = await server.inject({ method: 'GET', url: '/scans/search?limit=2' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nextCursor).not.toBeNull();
    expect(typeof body.nextCursor).toBe('string');
  });

  // SH11: GET /scans/search cursor pagination — passing cursor returns next page
  it('SH11: passing cursor returns next page', async () => {
    const store = getScanHistory();
    for (let i = 0; i < 5; i++) {
      store.record({ textPreview: `entry ${i}`, textHash: `hash-entry-${i}`, provider: 'mock', overallRisk: 'low', claimCount: 1, latencyMs: 100, timestamp: new Date().toISOString(), keyId: 'k' });
    }

    const firstRes = await server.inject({ method: 'GET', url: '/scans/search?limit=2' });
    const firstBody = JSON.parse(firstRes.body);
    expect(firstBody.nextCursor).not.toBeNull();

    const secondRes = await server.inject({ method: 'GET', url: `/scans/search?limit=2&cursor=${firstBody.nextCursor}` });
    expect(secondRes.statusCode).toBe(200);
    const secondBody = JSON.parse(secondRes.body);
    expect(Array.isArray(secondBody.scans)).toBe(true);
    // Second page IDs must not overlap with first page IDs
    const firstIds = new Set(firstBody.scans.map((s: { id: string }) => s.id));
    for (const s of secondBody.scans) {
      expect(firstIds.has(s.id)).toBe(false);
    }
  });

  // SH12: GET /scans/search?limit=2 respects limit
  it('SH12: GET /scans/search?limit=2 respects limit', async () => {
    const store = getScanHistory();
    for (let i = 0; i < 10; i++) {
      store.record({ textPreview: `entry ${i}`, textHash: `hash-entry-${i}`, provider: 'mock', overallRisk: 'low', claimCount: 1, latencyMs: 100, timestamp: new Date().toISOString(), keyId: 'k' });
    }

    const res = await server.inject({ method: 'GET', url: '/scans/search?limit=2' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scans.length).toBeLessThanOrEqual(2);
    expect(body.total).toBeLessThanOrEqual(2);
  });

  // SH13: GET /scans/search empty when no scans
  it('SH13: GET /scans/search returns empty when no scans', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/search' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.scans).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.total).toBe(0);
  });
});

// SH14 and SH15 are pure unit tests — no server needed
describe('ScanHistoryStore — unit tests', () => {
  beforeEach(() => {
    resetScanHistory();
  });

  // SH14: ScanHistoryStore.record() returns entry with id
  it('SH14: record() returns entry with id', () => {
    const store = getScanHistory();
    const entry = store.record({
      textPreview: 'some text',
      textHash: 'hash-some',
      provider: 'mock',
      overallRisk: 'low',
      claimCount: 3,
      latencyMs: 200,
      timestamp: new Date().toISOString(),
      keyId: 'key1',
    });
    expect(entry.id).toBeTruthy();
    expect(typeof entry.id).toBe('string');
    expect(entry.textPreview).toBe('some text');
    expect(entry.provider).toBe('mock');
    expect(entry.claimCount).toBe(3);
  });

  // SH15: ScanHistoryStore max 1000 entries
  it('SH15: ScanHistoryStore caps at 1000 entries', () => {
    const store = getScanHistory();
    for (let i = 0; i < 1005; i++) {
      store.record({
        textPreview: `entry ${i}`,
        textHash: `hash-${i}`,
        provider: 'mock',
        overallRisk: 'low',
        claimCount: 1,
        latencyMs: 50,
        timestamp: new Date().toISOString(),
        keyId: 'k',
      });
    }
    expect(store.size).toBe(1000);
    // Newest entry should be entry 1004 (last inserted, unshifted to front)
    const recent = store.getRecent(1);
    expect(recent[0].textPreview).toBe('entry 1004');
  });
});
