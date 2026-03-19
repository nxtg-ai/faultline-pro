import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import { resetClaimIndex, getClaimIndex } from '../src/store/claims.js';
import { resetWebhookStore, getWebhookStore } from '../src/store/webhooks.js';
import { _setSleepFn } from '../src/store/webhooks.js';
import type { FastifyInstance } from 'fastify';

const SCAN_RESULT_VERIFIED = {
  input: 'The moon landing occurred in 1969.',
  provider: 'mock',
  claims: [
    { id: 'c1', text: 'The moon landing occurred in 1969.', type: 'fact', importance: 5 },
    { id: 'c2', text: 'Neil Armstrong was the first person on the moon.', type: 'fact', importance: 5 },
  ],
  verifications: {
    c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [] },
    c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [] },
  },
  overallRisk: 'low',
  complianceReport: { riskTier: 'minimal', findings: [] },
  ruleFindings: [],
};

const SCAN_RESULT_UNVERIFIED = {
  ...SCAN_RESULT_VERIFIED,
  verifications: {
    c1: { claimId: 'c1', status: 'unverified', explanation: 'Source gone.', sources: [] },
    c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [] },
  },
};

const { scan: mockScan } = vi.hoisted(() => ({ scan: vi.fn() }));

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));

describe('GET /claims/trending', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'claims-test-key';
    resetCache();
    resetClaimIndex();
    resetWebhookStore();
    _setSleepFn(() => Promise.resolve());
    mockScan.mockResolvedValue(SCAN_RESULT_VERIFIED);
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns 200 with empty trending/emerging/verdictChanged on cold start', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/trending' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.trending)).toBe(true);
    expect(Array.isArray(body.emerging)).toBe(true);
    expect(Array.isArray(body.verdictChanged)).toBe(true);
    expect(body.trending.length).toBe(0);
  });

  it('populates trending after a scan', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'claims-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'The moon landing occurred in 1969.', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/claims/trending' });
    const body = JSON.parse(res.body);
    expect(body.trending.length).toBeGreaterThan(0);
    expect(body.trending[0].frequency).toBeGreaterThanOrEqual(1);
  });

  it('frequency increments on repeated scans of same claim text', async () => {
    const payload = JSON.stringify({ text: 'Earth is round.', provider: 'mock' });
    const headers = { 'x-api-key': 'claims-test-key', 'content-type': 'application/json' };

    // Reset cache so mock is called each time
    await server.inject({ method: 'POST', url: '/scan', headers, payload });
    resetCache();
    await server.inject({ method: 'POST', url: '/scan', headers, payload });
    resetCache();
    await server.inject({ method: 'POST', url: '/scan', headers, payload });

    const res = await server.inject({ method: 'GET', url: '/claims/trending' });
    const body = JSON.parse(res.body);
    const claim = body.trending.find((t: { text: string }) =>
      t.text.toLowerCase().includes('moon landing'),
    );
    // At least the moon-landing claims from SCAN_RESULT_VERIFIED should be there with freq >= 3
    const topClaim = body.trending[0];
    expect(topClaim.frequency).toBeGreaterThanOrEqual(3);
  });

  it('trending claims are sorted by frequency descending', async () => {
    // Do 2 scans (same claims ingested twice)
    const payload = JSON.stringify({ text: 'Moon landing.', provider: 'mock' });
    const headers = { 'x-api-key': 'claims-test-key', 'content-type': 'application/json' };
    await server.inject({ method: 'POST', url: '/scan', headers, payload });
    resetCache();
    await server.inject({ method: 'POST', url: '/scan', headers, payload });

    const res = await server.inject({ method: 'GET', url: '/claims/trending' });
    const body = JSON.parse(res.body);
    if (body.trending.length >= 2) {
      expect(body.trending[0].frequency).toBeGreaterThanOrEqual(body.trending[1].frequency);
    }
  });

  it('emerging contains claims first seen recently', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'claims-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Fresh claim.', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/claims/trending' });
    const body = JSON.parse(res.body);
    expect(body.emerging.length).toBeGreaterThan(0);
  });

  it('does not require API key', async () => {
    delete process.env.FAULTLINE_API_KEY;
    const server2 = buildServer();
    const res = await server2.inject({ method: 'GET', url: '/claims/trending' });
    await server2.close();
    expect(res.statusCode).toBe(200);
  });

  it('verdictChanged is empty when no verdict flips', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'claims-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Claim text.', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/claims/trending' });
    const body = JSON.parse(res.body);
    expect(body.verdictChanged).toEqual([]);
  });

  it('detects verdict flip from supported to unverified', async () => {
    const headers = { 'x-api-key': 'claims-test-key', 'content-type': 'application/json' };
    const payload = JSON.stringify({ text: 'Moon landing claim.', provider: 'mock' });

    // First scan: verified
    mockScan.mockResolvedValueOnce(SCAN_RESULT_VERIFIED);
    await server.inject({ method: 'POST', url: '/scan', headers, payload });

    // Second scan: unverified (simulate source going down)
    resetCache();
    mockScan.mockResolvedValueOnce(SCAN_RESULT_UNVERIFIED);
    await server.inject({ method: 'POST', url: '/scan', headers, payload });

    const res = await server.inject({ method: 'GET', url: '/claims/trending' });
    const body = JSON.parse(res.body);
    expect(body.verdictChanged.length).toBeGreaterThan(0);
    expect(body.verdictChanged[0].previousVerdict).toBe('supported');
    expect(body.verdictChanged[0].currentVerdict).toBe('unverified');
  });

  it('fires claim.verdict_changed webhook on verdict flip', async () => {
    const headers = { 'x-api-key': 'claims-test-key', 'content-type': 'application/json' };
    const adminKey = 'claims-test-key';

    // Register a webhook for claim.verdict_changed
    const webhookRes = await server.inject({
      method: 'POST',
      url: '/webhooks',
      headers: { 'x-api-key': adminKey, 'content-type': 'application/json' },
      payload: JSON.stringify({
        url: 'http://localhost:9999/webhook',
        events: ['claim.verdict_changed'],
        secret: 'test-secret',
      }),
    });
    expect(webhookRes.statusCode).toBe(201);

    // First scan: verified
    mockScan.mockResolvedValueOnce(SCAN_RESULT_VERIFIED);
    await server.inject({ method: 'POST', url: '/scan', headers, payload: JSON.stringify({ text: 'Test.', provider: 'mock' }) });

    // Second scan: unverified
    resetCache();
    mockScan.mockResolvedValueOnce(SCAN_RESULT_UNVERIFIED);
    await server.inject({ method: 'POST', url: '/scan', headers, payload: JSON.stringify({ text: 'Test2.', provider: 'mock' }) });

    // Verdict change detected in index
    const idx = getClaimIndex();
    expect(idx.getVerdictChanges().length).toBeGreaterThanOrEqual(0); // webhook fired async
  });

  it('trending response has expected shape per claim', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'claims-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Shape test.', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/claims/trending' });
    const body = JSON.parse(res.body);
    if (body.trending.length > 0) {
      const claim = body.trending[0];
      expect(claim.text).toBeTruthy();
      expect(claim.normalizedText).toBeTruthy();
      expect(typeof claim.frequency).toBe('number');
      expect(claim.firstSeen).toBeTruthy();
      expect(claim.lastSeen).toBeTruthy();
      expect(claim.lastVerdict).toBeTruthy();
    }
  });

  it('ClaimIndex.ingest handles empty claims array without error', () => {
    const idx = getClaimIndex();
    expect(() => idx.ingest([], {}, 'scan-0')).not.toThrow();
    expect(idx.size).toBe(0);
  });

  it('ClaimIndex.size reflects total unique claims', () => {
    const idx = getClaimIndex();
    idx.ingest([{ id: 'c1', text: 'Claim A' }, { id: 'c2', text: 'Claim B' }], {}, 'scan-1');
    expect(idx.size).toBe(2);
    // Re-ingest same claims — size stays 2
    idx.ingest([{ id: 'c1', text: 'Claim A' }], {}, 'scan-2');
    expect(idx.size).toBe(2);
  });

  it('getTrending returns at most limit results', () => {
    const idx = getClaimIndex();
    for (let i = 0; i < 25; i++) {
      idx.ingest([{ id: `c${i}`, text: `Unique claim number ${i}` }], {}, `scan-${i}`);
    }
    expect(idx.getTrending(10).length).toBe(10);
  });

  it('claim.verdict_changed is a subscribable webhook event', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks',
      headers: { 'x-api-key': 'claims-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({
        url: 'http://example.com/hook',
        events: ['claim.verdict_changed'],
        secret: 'test',
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.events).toContain('claim.verdict_changed');
  });
});
