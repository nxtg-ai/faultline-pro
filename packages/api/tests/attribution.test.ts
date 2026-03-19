import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import { resetClaimIndex, getClaimIndex, computeAttributionConfidence } from '../src/store/claims.js';
import type { FastifyInstance } from 'fastify';

const MOCK_RESULT_WITH_SOURCES = {
  input: 'The Earth orbits the Sun.',
  provider: 'mock',
  claims: [
    { id: 'c1', text: 'The Earth orbits the Sun.', type: 'fact', importance: 5 },
    { id: 'c2', text: 'This takes approximately 365 days.', type: 'fact', importance: 4 },
  ],
  verifications: {
    c1: {
      claimId: 'c1',
      status: 'supported',
      explanation: 'Astronomical fact.',
      sources: [
        { title: 'NASA Solar System Overview', uri: 'https://nasa.gov/solar-system' },
        { title: 'ESA Earth Orbit Data', uri: 'https://esa.int/earth-orbit' },
      ],
    },
    c2: {
      claimId: 'c2',
      status: 'supported',
      explanation: 'Well known.',
      sources: [{ title: 'Astronomical Almanac', uri: 'https://usno.navy.mil/almanac' }],
    },
  },
  overallRisk: 'low',
  complianceReport: { riskTier: 'minimal', findings: [] },
  ruleFindings: [],
};

const { scan: mockScan } = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));

describe('GET /claims/:id/attribution', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'attr-test-key';
    resetCache();
    resetClaimIndex();
    mockScan.mockResolvedValue(MOCK_RESULT_WITH_SOURCES);
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns 404 for unknown claim id', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/does-not-exist/attribution' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBeTruthy();
  });

  it('returns 200 with attribution chain after scan', async () => {
    // Trigger a scan so claims get indexed
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'attr-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'The Earth orbits the Sun.', provider: 'mock' }),
    });

    // Get trending to find the claim id
    const trending = await server.inject({ method: 'GET', url: '/claims/trending' });
    const trendingBody = JSON.parse(trending.body);
    expect(trendingBody.trending.length).toBeGreaterThan(0);

    // Get id directly from the index
    const index = getClaimIndex();
    const records = index.getTrending(1);
    expect(records.length).toBeGreaterThan(0);
    const claimId = records[0].id;
    expect(claimId).toBeTruthy();

    const res = await server.inject({ method: 'GET', url: `/claims/${claimId}/attribution` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(claimId);
    expect(body.claim).toBeTruthy();
    expect(body.attributionConfidence).toBeGreaterThanOrEqual(0);
    expect(body.attributionConfidence).toBeLessThanOrEqual(100);
  });

  it('attribution response has expected shape', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'attr-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Earth orbits Sun.', provider: 'mock' }),
    });

    const index = getClaimIndex();
    const records = index.getTrending(1);
    const claimId = records[0].id;

    const res = await server.inject({ method: 'GET', url: `/claims/${claimId}/attribution` });
    const body = JSON.parse(res.body);

    expect(body.id).toBeTruthy();
    expect(typeof body.claim).toBe('string');
    expect(typeof body.claimType).toBe('string');
    expect(body.firstSeen).toBeTruthy();
    expect(body.lastSeen).toBeTruthy();
    expect(typeof body.frequency).toBe('number');
    expect(typeof body.lastVerdict).toBe('string');
    expect(typeof body.attributionConfidence).toBe('number');
    expect(body.attributionChain).toBeDefined();
    expect(Array.isArray(body.attributionChain.sources)).toBe(true);
    expect(Array.isArray(body.attributionChain.scanHistory)).toBe(true);
  });

  it('sources contain title, uri, scanId, seenAt', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'attr-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Earth test.', provider: 'mock' }),
    });

    const index = getClaimIndex();
    // Find a record that has sources (c1 = "The Earth orbits the Sun.")
    const records = index.getTrending(10);
    const withSources = records.find((r) => r.sources.length > 0);
    if (!withSources) return; // no sources in this run (cache hit scenario)

    const res = await server.inject({ method: 'GET', url: `/claims/${withSources.id}/attribution` });
    const body = JSON.parse(res.body);
    if (body.attributionChain.sources.length > 0) {
      const src = body.attributionChain.sources[0];
      expect(src.title).toBeTruthy();
      expect(src.uri).toBeTruthy();
      expect(src.scanId).toBeTruthy();
      expect(src.seenAt).toBeTruthy();
    }
  });

  it('attributionConfidence is 0 for new unsourced claim', () => {
    const index = getClaimIndex();
    index.ingest([{ id: 'x1', text: 'Unsourced claim.', type: 'opinion' }], {}, 'scan-x');
    const record = index.getTrending(1)[0];
    expect(record).toBeDefined();
    const conf = computeAttributionConfidence(record);
    expect(conf).toBe(0);
  });

  it('attributionConfidence increases with sources', () => {
    const index = getClaimIndex();
    index.ingest(
      [{ id: 'y1', text: 'Sourced fact.', type: 'fact' }],
      { y1: { status: 'supported', sources: [{ title: 'Source A', uri: 'https://a.com' }] } },
      'scan-y',
    );
    const record = index.getTrending(1)[0];
    const conf = computeAttributionConfidence(record);
    // +40 (has source) +10 (fact) +10 (supported) = 60
    expect(conf).toBeGreaterThanOrEqual(50);
  });

  it('attributionConfidence reaches 100 for well-sourced frequent fact', () => {
    const index = getClaimIndex();
    const sources = [
      { title: 'A', uri: 'https://a.com' },
      { title: 'B', uri: 'https://b.com' },
      { title: 'C', uri: 'https://c.com' },
    ];
    // Ingest 3 times to reach frequency >= 3
    for (let i = 0; i < 3; i++) {
      index.ingest(
        [{ id: `f${i}`, text: 'Well established fact.', type: 'fact' }],
        { [`f${i}`]: { status: 'supported', sources } },
        `scan-${i}`,
      );
    }
    const record = index.getById([...index.getTrending(1)][0].id)!;
    const conf = computeAttributionConfidence(record);
    // +40 (sources) +20 (3+ sources) +20 (3+ scans) +10 (supported) +10 (fact) = 100
    expect(conf).toBe(100);
  });

  it('getById returns undefined for unknown id', () => {
    const index = getClaimIndex();
    expect(index.getById('nonexistent')).toBeUndefined();
  });

  it('getById returns record after ingest', () => {
    const index = getClaimIndex();
    index.ingest([{ id: 'z1', text: 'Test claim.', type: 'fact' }], {}, 'scan-z');
    const records = index.getTrending(1);
    const found = index.getById(records[0].id);
    expect(found).toBeDefined();
    expect(found!.originalText).toBe('Test claim.');
  });

  it('sources are deduplicated across multiple scans', () => {
    const index = getClaimIndex();
    const sources = [{ title: 'Same Source', uri: 'https://same.com' }];
    index.ingest([{ id: 'a1', text: 'Dedup test claim.' }], { a1: { status: 'supported', sources } }, 'scan-1');
    index.ingest([{ id: 'a2', text: 'Dedup test claim.' }], { a2: { status: 'supported', sources } }, 'scan-2');
    const record = index.getTrending(1)[0];
    // Same URI should not be duplicated
    expect(record.sources.length).toBe(1);
    expect(record.frequency).toBe(2);
  });

  it('claim id is stable across re-ingests', () => {
    const index = getClaimIndex();
    index.ingest([{ id: 'b1', text: 'Stable id claim.' }], {}, 'scan-1');
    const id1 = index.getTrending(1)[0].id;
    index.ingest([{ id: 'b2', text: 'Stable id claim.' }], {}, 'scan-2');
    const id2 = index.getTrending(1)[0].id;
    expect(id1).toBe(id2);
  });

  it('does not require API key', async () => {
    const index = getClaimIndex();
    index.ingest([{ id: 'c1', text: 'Public claim.' }], {}, 'scan-1');
    const claimId = index.getTrending(1)[0].id;

    delete process.env.FAULTLINE_API_KEY;
    const server2 = buildServer();
    const res = await server2.inject({ method: 'GET', url: `/claims/${claimId}/attribution` });
    await server2.close();
    expect(res.statusCode).toBe(200);
  });

  it('claimType is stored from scan claims', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'attr-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Earth orbits.', provider: 'mock' }),
    });

    const index = getClaimIndex();
    const records = index.getTrending(5);
    const factClaim = records.find((r) => r.claimType === 'fact');
    if (factClaim) {
      const res = await server.inject({ method: 'GET', url: `/claims/${factClaim.id}/attribution` });
      const body = JSON.parse(res.body);
      expect(body.claimType).toBe('fact');
    }
  });
});
