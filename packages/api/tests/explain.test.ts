import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import { resetClaimIndex, getClaimIndex } from '../src/store/claims.js';
import type { FastifyInstance } from 'fastify';

const MOCK_RESULT = {
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

describe('GET /claims/:id/explain', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'explain-test-key';
    resetCache();
    resetClaimIndex();
    mockScan.mockResolvedValue(MOCK_RESULT);
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  // EX1: 200 with all fields
  it('EX1: returns 200 with all expected fields after scan', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'explain-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'The Earth orbits the Sun.', provider: 'mock' }),
    });

    const index = getClaimIndex();
    const records = index.getTrending(1);
    expect(records.length).toBeGreaterThan(0);
    const claimId = records[0].id;

    const res = await server.inject({ method: 'GET', url: `/claims/${claimId}/explain` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claim).toBeDefined();
    expect(body.claimType).toBeDefined();
    expect(body.verdict).toBeDefined();
    expect(body.confidence).toBeDefined();
    expect(body.reasoningChain).toBeDefined();
    expect(body.evidenceFound).toBeDefined();
    expect(Array.isArray(body.suggestions)).toBe(true);
  });

  // EX2: 404 for unknown id
  it('EX2: returns 404 for unknown claim id', async () => {
    const res = await server.inject({ method: 'GET', url: '/claims/does-not-exist/explain' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBeTruthy();
  });

  // EX3: Response shape — claim, claimType, verdict, confidence, reasoningChain, evidenceFound, suggestions
  it('EX3: response has correct shape with expected field types', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'explain-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Earth orbits Sun.', provider: 'mock' }),
    });

    const index = getClaimIndex();
    const claimId = index.getTrending(1)[0].id;

    const res = await server.inject({ method: 'GET', url: `/claims/${claimId}/explain` });
    const body = JSON.parse(res.body);

    expect(typeof body.claim).toBe('string');
    expect(typeof body.claimType).toBe('string');
    expect(typeof body.verdict).toBe('string');
    expect(typeof body.confidence).toBe('number');
    expect(Array.isArray(body.reasoningChain)).toBe(true);
    expect(Array.isArray(body.evidenceFound)).toBe(true);
    expect(Array.isArray(body.suggestions)).toBe(true);
  });

  // EX4: reasoningChain is a non-empty array of strings
  it('EX4: reasoningChain is a non-empty array of strings', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'explain-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Earth orbits Sun.', provider: 'mock' }),
    });

    const index = getClaimIndex();
    const claimId = index.getTrending(1)[0].id;

    const res = await server.inject({ method: 'GET', url: `/claims/${claimId}/explain` });
    const body = JSON.parse(res.body);

    expect(body.reasoningChain.length).toBeGreaterThan(0);
    for (const step of body.reasoningChain) {
      expect(typeof step).toBe('string');
    }
  });

  // EX5: evidenceFound is an array (empty when no sources)
  it('EX5: evidenceFound is an array, empty when claim has no sources', () => {
    const index = getClaimIndex();
    index.ingest([{ id: 'nosrc1', text: 'Unsourced claim.', type: 'opinion' }], {}, 'scan-ns');
    const claimId = index.getTrending(1)[0].id;

    const explanation = index.explain(claimId);
    expect(explanation).not.toBeNull();
    expect(Array.isArray(explanation!.evidenceFound)).toBe(true);
    expect(explanation!.evidenceFound.length).toBe(0);
  });

  // EX6: suggestions is a non-empty array
  it('EX6: suggestions is a non-empty array', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'explain-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Earth orbits Sun.', provider: 'mock' }),
    });

    const index = getClaimIndex();
    const claimId = index.getTrending(1)[0].id;

    const res = await server.inject({ method: 'GET', url: `/claims/${claimId}/explain` });
    const body = JSON.parse(res.body);

    expect(body.suggestions.length).toBeGreaterThan(0);
  });

  // EX7: confidence is a number 0–100
  it('EX7: confidence is a number between 0 and 100 inclusive', async () => {
    await server.inject({
      method: 'POST',
      url: '/scan',
      headers: { 'x-api-key': 'explain-test-key', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'Earth orbits Sun.', provider: 'mock' }),
    });

    const index = getClaimIndex();
    const claimId = index.getTrending(1)[0].id;

    const res = await server.inject({ method: 'GET', url: `/claims/${claimId}/explain` });
    const body = JSON.parse(res.body);

    expect(body.confidence).toBeGreaterThanOrEqual(0);
    expect(body.confidence).toBeLessThanOrEqual(100);
  });

  // EX8: Well-supported claim (freq≥3, sources≥3, verdict=supported) → "no action required"
  it('EX8: well-supported claim suggestions includes "no action required"', () => {
    const index = getClaimIndex();
    const sources = [
      { title: 'A', uri: 'https://a.com' },
      { title: 'B', uri: 'https://b.com' },
      { title: 'C', uri: 'https://c.com' },
    ];
    for (let i = 0; i < 3; i++) {
      index.ingest(
        [{ id: `ws${i}`, text: 'Well established fact.', type: 'fact' }],
        { [`ws${i}`]: { status: 'supported', sources } },
        `scan-ws-${i}`,
      );
    }
    const claimId = index.getTrending(1)[0].id;
    const explanation = index.explain(claimId);
    expect(explanation).not.toBeNull();
    expect(explanation!.confidence).toBeGreaterThanOrEqual(60);
    const hasNoAction = explanation!.suggestions.some((s) => s.includes('no action required'));
    expect(hasNoAction).toBe(true);
  });

  // EX9: Unverified claim with no sources → source-related advice
  it('EX9: unverified claim with no sources gets source-related suggestions', () => {
    const index = getClaimIndex();
    index.ingest(
      [{ id: 'uv1', text: 'Some unverified claim.', type: 'opinion' }],
      { uv1: { status: 'unverified', sources: [] } },
      'scan-uv',
    );
    const claimId = index.getTrending(1)[0].id;
    const explanation = index.explain(claimId);
    expect(explanation).not.toBeNull();
    const hasSourceAdvice = explanation!.suggestions.some(
      (s) => s.toLowerCase().includes('source'),
    );
    expect(hasSourceAdvice).toBe(true);
  });

  // EX10: explain() unit test — null for unknown id
  it('EX10: explain() returns null for unknown id', () => {
    const index = getClaimIndex();
    expect(index.explain('nonexistent-id')).toBeNull();
  });

  // EX11: reasoningChain includes the verdict string
  it('EX11: reasoningChain includes a step containing the verdict', () => {
    const index = getClaimIndex();
    index.ingest(
      [{ id: 'rv1', text: 'Verdict chain claim.', type: 'fact' }],
      { rv1: { status: 'contradicted', sources: [] } },
      'scan-rv',
    );
    const claimId = index.getTrending(1)[0].id;
    const explanation = index.explain(claimId);
    expect(explanation).not.toBeNull();
    const hasVerdict = explanation!.reasoningChain.some((step) =>
      step.includes('contradicted'),
    );
    expect(hasVerdict).toBe(true);
  });

  // EX12: evidenceFound entries have title, uri, seenAt when sources exist
  it('EX12: evidenceFound entries contain title, uri, and seenAt', () => {
    const index = getClaimIndex();
    index.ingest(
      [{ id: 'ef1', text: 'Evidence claim.', type: 'fact' }],
      {
        ef1: {
          status: 'supported',
          sources: [
            { title: 'My Source', uri: 'https://example.com/source' },
          ],
        },
      },
      'scan-ef',
    );
    const claimId = index.getTrending(1)[0].id;
    const explanation = index.explain(claimId);
    expect(explanation).not.toBeNull();
    expect(explanation!.evidenceFound.length).toBeGreaterThan(0);
    const entry = explanation!.evidenceFound[0];
    expect(typeof entry.title).toBe('string');
    expect(typeof entry.uri).toBe('string');
    expect(typeof entry.seenAt).toBe('string');
    expect(entry.title).toBe('My Source');
    expect(entry.uri).toBe('https://example.com/source');
    expect(entry.seenAt).toBeTruthy();
  });
});
