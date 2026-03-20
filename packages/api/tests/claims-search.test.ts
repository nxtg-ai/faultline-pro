import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import { resetClaimIndex, getClaimIndex } from '../src/store/claims.js';
import type { FastifyInstance } from 'fastify';

const SCAN_RESULT_BASE = {
  input: 'The moon landing occurred in 1969.',
  provider: 'mock',
  claims: [
    { id: 'c1', text: 'The moon landing occurred in 1969.', type: 'fact', importance: 5 },
    { id: 'c2', text: 'Neil Armstrong was the first person on the moon.', type: 'fact', importance: 5 },
  ],
  verifications: {
    c1: { claimId: 'c1', status: 'supported', explanation: 'Confirmed.', sources: [{ title: 'NASA', uri: 'https://nasa.gov/moon' }] },
    c2: { claimId: 'c2', status: 'supported', explanation: 'Confirmed.', sources: [] },
  },
  overallRisk: 'low',
  complianceReport: { riskTier: 'minimal', findings: [] },
  ruleFindings: [],
};

const SCAN_RESULT_UNVERIFIED = {
  ...SCAN_RESULT_BASE,
  verifications: {
    c1: { claimId: 'c1', status: 'unverified', explanation: 'No source.', sources: [] },
    c2: { claimId: 'c2', status: 'unverified', explanation: 'No source.', sources: [] },
  },
};

const SCAN_RESULT_SECOND = {
  input: 'Water boils at 100 degrees Celsius.',
  provider: 'mock',
  claims: [
    { id: 'd1', text: 'Water boils at 100 degrees Celsius.', type: 'fact', importance: 4 },
  ],
  verifications: {
    d1: { claimId: 'd1', status: 'supported', explanation: 'Confirmed.', sources: [{ title: 'Science Daily', uri: 'https://sciencedaily.com/water' }] },
  },
  overallRisk: 'low',
  complianceReport: { riskTier: 'minimal', findings: [] },
  ruleFindings: [],
};

const { scan: mockScan } = vi.hoisted(() => ({ scan: vi.fn() }));

vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));

describe('GET /claims (search)', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-key';
    resetCache();
    resetClaimIndex();
    mockScan.mockResolvedValue(SCAN_RESULT_BASE);
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  // CS7: GET /claims returns empty array when no claims
  it('CS7: returns 200 with empty claims array on cold start', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.claims)).toBe(true);
    expect(body.claims.length).toBe(0);
    expect(body.total).toBe(0);
  });

  // CS1: GET /claims with no params returns all claims (200 + array)
  it('CS1: returns all claims with no params after a scan', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Moon landing.', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/claims' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.claims)).toBe(true);
    expect(body.claims.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.claims.length);
  });

  // CS6: GET /claims returns id, text, claimType, frequency, lastVerdict, sourceCount fields
  it('CS6: claims have expected shape with all required fields', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Shape test.', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/claims' });
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBeGreaterThan(0);
    const claim = body.claims[0];
    expect(typeof claim.id).toBe('string');
    expect(claim.id.length).toBeGreaterThan(0);
    expect(typeof claim.text).toBe('string');
    expect(typeof claim.normalizedText).toBe('string');
    expect(typeof claim.claimType).toBe('string');
    expect(typeof claim.firstSeen).toBe('string');
    expect(typeof claim.lastSeen).toBe('string');
    expect(typeof claim.frequency).toBe('number');
    expect(typeof claim.lastVerdict).toBe('string');
    expect(typeof claim.sourceCount).toBe('number');
  });

  // CS2: GET /claims?text= filters by text substring
  it('CS2: filters claims by text substring', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Moon text.', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/claims?text=moon+landing' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBeGreaterThan(0);
    for (const claim of body.claims) {
      expect(claim.normalizedText.toLowerCase()).toContain('moon landing');
    }
  });

  // CS2 negative: text filter returns empty when no match
  it('CS2: returns empty array when text filter matches nothing', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Moon test.', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/claims?text=zzznomatch' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBe(0);
    expect(body.total).toBe(0);
  });

  // CS3: GET /claims?verdict= filters by verdict
  it('CS3: filters claims by verdict', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Verdict test.', provider: 'mock' }),
    });

    const resSupported = await server.inject({ method: 'GET', url: '/claims?verdict=supported' });
    expect(resSupported.statusCode).toBe(200);
    const bodySupported = JSON.parse(resSupported.body);
    for (const claim of bodySupported.claims) {
      expect(claim.lastVerdict).toBe('supported');
    }

    mockScan.mockResolvedValueOnce(SCAN_RESULT_UNVERIFIED);
    resetCache();
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Verdict test 2.', provider: 'mock' }),
    });

    const resUnverified = await server.inject({ method: 'GET', url: '/claims?verdict=unverified' });
    expect(resUnverified.statusCode).toBe(200);
    const bodyUnverified = JSON.parse(resUnverified.body);
    expect(bodyUnverified.claims.length).toBeGreaterThan(0);
    for (const claim of bodyUnverified.claims) {
      expect(claim.lastVerdict).toBe('unverified');
    }
  });

  // CS4: GET /claims?from= filters by date range
  it('CS4: filters by from date — future cutoff returns empty', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Date test.', provider: 'mock' }),
    });

    // A from date far in the future should return nothing
    const futureDate = '2099-01-01T00:00:00.000Z';
    const res = await server.inject({ method: 'GET', url: `/claims?from=${encodeURIComponent(futureDate)}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBe(0);
  });

  it('CS4: filters by from date — past cutoff returns all claims', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Date test from.', provider: 'mock' }),
    });

    const pastDate = '2000-01-01T00:00:00.000Z';
    const res = await server.inject({ method: 'GET', url: `/claims?from=${encodeURIComponent(pastDate)}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBeGreaterThan(0);
  });

  // CS5: GET /claims?limit=2 respects limit
  it('CS5: respects limit query param', async () => {
    // Ingest enough claims via direct index manipulation
    const idx = getClaimIndex();
    for (let i = 0; i < 10; i++) {
      idx.ingest([{ id: `lim${i}`, text: `Limit test claim number ${i}` }], {}, `scan-lim-${i}`);
    }

    const res = await server.inject({ method: 'GET', url: '/claims?limit=2' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBeLessThanOrEqual(2);
    expect(body.total).toBeLessThanOrEqual(2);
  });

  // CS5 cap: limit is capped at 200
  it('CS5: limit is capped at 200', async () => {
    const idx = getClaimIndex();
    for (let i = 0; i < 210; i++) {
      idx.ingest([{ id: `cap${i}`, text: `Cap test claim number ${i}` }], {}, `scan-cap-${i}`);
    }

    const res = await server.inject({ method: 'GET', url: '/claims?limit=999' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBeLessThanOrEqual(200);
  });

  // CS8: GET /claims?source= filters by source uri/title
  it('CS8: filters by source URI substring', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Source filter test.', provider: 'mock' }),
    });

    // c1 has source uri https://nasa.gov/moon
    const res = await server.inject({ method: 'GET', url: '/claims?source=nasa.gov' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBeGreaterThan(0);
    for (const claim of body.claims) {
      // Every returned claim should have at least one source matching nasa.gov
      // (we can't inspect sources directly from the response, but sourceCount > 0)
      expect(claim.sourceCount).toBeGreaterThan(0);
    }
  });

  it('CS8: source filter returns empty when no match', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Source none test.', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/claims?source=zzznomatch' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBe(0);
  });

  // CS9: total field equals claims array length
  it('CS9: total field always equals claims array length', async () => {
    const idx = getClaimIndex();
    idx.ingest(
      [
        { id: 'tot1', text: 'Total test claim one' },
        { id: 'tot2', text: 'Total test claim two' },
        { id: 'tot3', text: 'Total test claim three' },
      ],
      {},
      'scan-total',
    );

    const res = await server.inject({ method: 'GET', url: '/claims' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(body.claims.length);
  });

  // CS10: Multiple scans, GET /claims returns all deduplicated claims
  it('CS10: multiple scans return deduplicated claims', async () => {
    const headers = { 'x-api-key': 'test-key', 'content-type': 'application/json' };
    const payload = JSON.stringify({ text: 'Dedup test.', provider: 'mock' });

    await server.inject({ method: 'POST', url: '/scan', headers, payload });
    resetCache();
    mockScan.mockResolvedValueOnce(SCAN_RESULT_SECOND);
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers,
      payload: JSON.stringify({ text: 'Water boils.', provider: 'mock' }),
    });

    const res = await server.inject({ method: 'GET', url: '/claims' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should have claims from both scans
    expect(body.claims.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.claims.length);

    // Verify no duplicate ids
    const ids = body.claims.map((c: { id: string }) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('CS10: repeated scan of same text increments frequency, not claim count', async () => {
    const headers = { 'x-api-key': 'test-key', 'content-type': 'application/json' };
    const payload = JSON.stringify({ text: 'Freq dedup test.', provider: 'mock' });

    await server.inject({ method: 'POST', url: '/scan', headers, payload });
    resetCache();
    await server.inject({ method: 'POST', url: '/scan', headers, payload });

    const res = await server.inject({ method: 'GET', url: '/claims' });
    const body = JSON.parse(res.body);

    // SCAN_RESULT_BASE has 2 unique claims; repeated scan should not duplicate them
    const moonClaim = body.claims.find((c: { text: string }) =>
      c.text.toLowerCase().includes('moon landing'),
    );
    if (moonClaim) {
      expect(moonClaim.frequency).toBeGreaterThanOrEqual(2);
    }
    // Total unique claims remains 2 (the 2 from SCAN_RESULT_BASE)
    expect(body.claims.length).toBe(2);
  });
});
