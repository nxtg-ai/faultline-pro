/**
 * Tests for claim database UI routes + ClaimIndex.getStats()
 * Covers: GET /claims/stats, GET /claims/view
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getClaimIndex, resetClaimIndex } from '../src/store/claims.js';
import type { FastifyInstance } from 'fastify';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function ingest(scanId = 'scan-1') {
  getClaimIndex().ingest(
    [
      { id: 'c1', text: 'Revenue grew 45% in 2024.', type: 'fact' },
      { id: 'c2', text: 'The product has 10 million users.', type: 'fact' },
      { id: 'c3', text: 'Carbon emissions dropped last quarter.', type: 'fact' },
    ],
    {
      c1: { status: 'supported',    sources: [{ title: 'Annual Report', uri: 'https://example.com/report' }] },
      c2: { status: 'contradicted', sources: [] },
      c3: { status: 'unverified',   sources: [] },
    },
    scanId,
  );
}

function setup() {
  resetClaimIndex();
  process.env.FAULTLINE_API_KEY = 'test-key';
}

// ── ClaimIndex.getStats() unit tests ──────────────────────────────────────────

describe('ClaimIndex.getStats()', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('returns zeros for empty index', () => {
    const s = getClaimIndex().getStats();
    expect(s.totalClaims).toBe(0);
    expect(s.totalScans).toBe(0);
    expect(s.accuracyRate).toBe(0);
    expect(s.verifiedRate).toBe(0);
    expect(s.topSources).toHaveLength(0);
  });

  it('totalClaims matches ingest count', () => {
    ingest();
    expect(getClaimIndex().getStats().totalClaims).toBe(3);
  });

  it('totalScans counts unique scanIds', () => {
    ingest('scan-1');
    ingest('scan-2');
    // 2 ingests with same claims → same 3 records but 2 scanIds recorded in verdicts
    const s = getClaimIndex().getStats();
    expect(s.totalScans).toBe(2);
  });

  it('byVerdict counts by lastVerdict', () => {
    ingest();
    const s = getClaimIndex().getStats();
    expect(s.byVerdict['supported']).toBe(1);
    expect(s.byVerdict['contradicted']).toBe(1);
    expect(s.byVerdict['unverified']).toBe(1);
  });

  it('accuracyRate = supported / (supported + contradicted)', () => {
    ingest();
    const s = getClaimIndex().getStats();
    expect(s.accuracyRate).toBeCloseTo(0.5);  // 1 supported / (1+1)
  });

  it('accuracyRate is 1.0 when all claims are supported', () => {
    getClaimIndex().ingest(
      [{ id: 'x1', text: 'All true.' }],
      { x1: { status: 'supported', sources: [] } },
      'scan-x',
    );
    expect(getClaimIndex().getStats().accuracyRate).toBe(1);
  });

  it('accuracyRate is 0 when all claims are contradicted', () => {
    getClaimIndex().ingest(
      [{ id: 'x1', text: 'All false.' }],
      { x1: { status: 'contradicted', sources: [] } },
      'scan-x',
    );
    expect(getClaimIndex().getStats().accuracyRate).toBe(0);
  });

  it('verifiedRate = supported / total', () => {
    ingest();
    const s = getClaimIndex().getStats();
    expect(s.verifiedRate).toBeCloseTo(1 / 3);
  });

  it('claimTypes counts by type', () => {
    ingest();
    const s = getClaimIndex().getStats();
    expect(s.claimTypes['fact']).toBe(3);
  });

  it('avgFrequency equals total frequency / claim count', () => {
    ingest();  // frequency = 1 for each claim after first ingest
    const s = getClaimIndex().getStats();
    expect(s.avgFrequency).toBe(1);
  });

  it('topSources extracts hostnames from source URIs', () => {
    ingest();
    const s = getClaimIndex().getStats();
    // c1 has source https://example.com/report → host = 'example.com'
    expect(s.topSources.length).toBeGreaterThan(0);
    expect(s.topSources[0].uri).toBe('example.com');
    expect(s.topSources[0].count).toBe(1);
  });

  it('topSources is limited to top 10', () => {
    // Ingest 12 claims with different source domains
    const claims = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, text: `Claim ${i}` }));
    const verifs: Record<string, { status: string; sources: Array<{ title: string; uri: string }> }> = {};
    claims.forEach((c, i) => {
      verifs[c.id] = { status: 'supported', sources: [{ title: `Source ${i}`, uri: `https://domain${i}.com/` }] };
    });
    getClaimIndex().ingest(claims, verifs, 'scan-many');
    const s = getClaimIndex().getStats();
    expect(s.topSources.length).toBeLessThanOrEqual(10);
  });

  it('topSources aggregates multiple claims with same host', () => {
    getClaimIndex().ingest(
      [
        { id: 'a1', text: 'Claim A' },
        { id: 'a2', text: 'Claim B' },
      ],
      {
        a1: { status: 'supported', sources: [{ title: 'Reuters', uri: 'https://reuters.com/a' }] },
        a2: { status: 'supported', sources: [{ title: 'Reuters', uri: 'https://reuters.com/b' }] },
      },
      'scan-multi-source',
    );
    const s = getClaimIndex().getStats();
    const reuters = s.topSources.find(x => x.uri === 'reuters.com');
    expect(reuters?.count).toBe(2);
  });
});

// ── GET /claims/stats ─────────────────────────────────────────────────────────

describe('GET /claims/stats', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with stats shape', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/stats' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.totalClaims).toBe('number');
    expect(typeof body.accuracyRate).toBe('number');
    expect(typeof body.verifiedRate).toBe('number');
    expect(typeof body.totalScans).toBe('number');
    expect(typeof body.byVerdict).toBe('object');
    expect(Array.isArray(body.topSources)).toBe(true);
  });

  it('returns correct counts after ingest', async () => {
    ingest();
    const res = await server.inject({ method: 'GET', url: '/claims/stats' });
    const body = JSON.parse(res.body);
    expect(body.totalClaims).toBe(3);
    expect(body.byVerdict.supported).toBe(1);
    expect(body.byVerdict.contradicted).toBe(1);
    expect(body.byVerdict.unverified).toBe(1);
  });

  it('accuracyRate is in [0, 1]', async () => {
    ingest();
    const res = await server.inject({ method: 'GET', url: '/claims/stats' });
    const body = JSON.parse(res.body);
    expect(body.accuracyRate).toBeGreaterThanOrEqual(0);
    expect(body.accuracyRate).toBeLessThanOrEqual(1);
  });

  it('returns 200 for empty index', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/stats' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).totalClaims).toBe(0);
  });

  it('no auth required', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/stats' });
    expect(res.statusCode).toBe(200);
  });
});

// ── GET /claims/view ──────────────────────────────────────────────────────────

describe('GET /claims/view', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with text/html', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/view' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML contains Claim Database heading', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/view' });
    expect(res.body).toContain('Claim Database');
  });

  it('HTML contains search form fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/view' });
    expect(res.body).toContain('f-text');
    expect(res.body).toContain('f-verdict');
    expect(res.body).toContain('f-from');
    expect(res.body).toContain('f-source');
  });

  it('HTML contains stats bar placeholders', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/view' });
    expect(res.body).toContain('Accuracy Rate');
    expect(res.body).toContain('Total Claims');
    expect(res.body).toContain('Scans Indexed');
    expect(res.body).toContain('Verified Claims');
  });

  it('HTML contains trending sidebar', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/view' });
    expect(res.body).toContain('Trending Claims');
    expect(res.body).toContain('Emerging');
    expect(res.body).toContain('Verdict Breakdown');
  });

  it('HTML contains JS fetch calls to /claims and /claims/trending', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/view' });
    expect(res.body).toContain('/claims/stats');
    expect(res.body).toContain('/claims/trending');
    expect(res.body).toContain('/claims?');
  });

  it('no auth required (public page)', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/view' });
    expect(res.statusCode).toBe(200);
  });
});
