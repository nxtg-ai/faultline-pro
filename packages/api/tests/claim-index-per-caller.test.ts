/**
 * The claim index is kept per caller, and Gemini Grounded Results never enter
 * it (emma-soul al:1fba541b5d8c468f, GoPMO 1.18.11.3). It was one index
 * shared by every caller, holding Gemini verdicts across all of them: Google's
 * terms forbid caching or storing Grounded Results and allow showing them only
 * to the user who submitted the prompt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import { resetClaimIndex, getClaimIndex } from '../src/store/claims.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import type { FastifyInstance } from 'fastify';

const GROUNDING_URI = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC';
const PLAIN = 'The Eiffel Tower is in Paris.';
const GROUNDED = 'Mount Everest is the highest mountain.';

function result(text: string, verification: Record<string, unknown>, provider = 'mock') {
  return {
    input: text, provider,
    claims: [{ id: 'c1', text, type: 'fact', importance: 3 }],
    verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'x', sources: [], ...verification } },
    overallRisk: 'low', complianceReport: { riskTier: 'minimal', findings: [] }, ruleFindings: [],
  };
}

const { scan: mockScan } = vi.hoisted(() => ({ scan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: mockScan }));
vi.mock('@nxtg/faultline/cli/compliance-report.js', () => ({
  buildEuComplianceReport: vi.fn().mockReturnValue({ complianceScore: 72 }),
  evaluateComplianceGate: vi.fn().mockReturnValue({ pass: true }),
}));

const ADMIN = 'claim-index-admin';

describe('claim index is per caller and never holds Grounded Results', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    resetCache(); resetClaimIndex(); resetKeyStore();
    mockScan.mockReset().mockResolvedValue(result(PLAIN, { sources: [{ title: 't', uri: 'https://example.org/a' }] }));
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  async function scanAs(key: string, text: string, provider = 'mock', ref?: string) {
    const res = await server.inject({ method: 'POST', url: '/scan', headers: { 'x-api-key': key, 'content-type': 'application/json', ...(ref ? { 'x-faultline-user-ref': ref } : {}) }, body: JSON.stringify({ text, provider }) });
    expect(res.statusCode, res.body).toBe(200);
  }
  const get = (url: string, key: string, ref?: string) => server.inject({ method: 'GET', url, headers: { 'x-api-key': key, ...(ref ? { 'x-faultline-user-ref': ref } : {}) } });

  it('CI-1. key B sees none of key A\'s claims, on any claim route', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const b = getKeyStore().create('B', ['scan']);
    await scanAs(a.key, 'input one');
    const own = JSON.parse((await get('/claims', a.key)).body);
    expect(own.claims.length).toBe(1);
    const id = own.claims[0].id;

    for (const url of ['/claims', '/claims/trending', '/claims/stats', `/claims/${id}/attribution`, `/claims/${id}/explain`]) {
      const res = await get(url, b.key);
      expect(res.body, url).not.toContain(PLAIN);
      expect(res.body, url).not.toContain('example.org');
    }
    expect(JSON.parse((await get('/claims/stats', b.key)).body).totalClaims).toBe(0);
    expect((await get(`/claims/${id}/attribution`, b.key)).statusCode).toBe(404);
  });

  it('CI-2. behind the server key each faultline-web user has their own index; no user ref indexes nothing', async () => {
    await scanAs(ADMIN, 'input one', 'mock', 'webuser0001');
    await scanAs(ADMIN, 'input two');
    expect(JSON.parse((await get('/claims', ADMIN, 'webuser0001')).body).claims.length).toBe(1);
    expect(JSON.parse((await get('/claims', ADMIN, 'webuser0002')).body).claims.length).toBe(0);
    expect(JSON.parse((await get('/claims', ADMIN)).body).claims.length).toBe(0);
  });

  it.each([
    ['provider gemini', 'gemini', {}],
    ['provenance gemini-grounding', 'mock', { provenance: { provider: 'gemini', model: 'm', verifiedAt: 'x', retriever: 'gemini-grounding', retrievedAt: 'x' } }],
    ['a grounding Link among the sources', 'mock', { sources: [{ title: 't', uri: GROUNDING_URI }] }],
    ['Search Suggestions', 'mock', { searchEntryPoint: { renderedContent: '<div/>' } }],
  ])('CI-3. a Gemini-grounded verdict (%s) is never stored, not even for its own caller', async (_name, provider, verification) => {
    const a = getKeyStore().create('A', ['scan']);
    mockScan.mockResolvedValue(result(GROUNDED, verification, provider === 'gemini' ? 'Google Gemini' : 'mock'));
    await scanAs(a.key, 'grounded input', provider);
    const res = JSON.parse((await get('/claims', a.key)).body);
    expect(res.claims.length).toBe(0);
    expect(getClaimIndex().getStats(`${a.id}\u0000${a.id}`).totalClaims).toBe(0);
  });

  it('CI-6. a scan with no caller (server key, no user ref) stores nothing at all', async () => {
    await scanAs(ADMIN, 'input one');
    expect(getClaimIndex().size).toBe(0);
  });

  it('CI-4. in a mixed result only the non-grounded verdict is stored', () => {
    const caller = 'k\u0000k';
    getClaimIndex().ingest(
      [{ id: 'c1', text: PLAIN }, { id: 'c2', text: GROUNDED }],
      { c1: { status: 'supported', sources: [] }, c2: { status: 'supported', sources: [{ title: 't', uri: GROUNDING_URI }] } },
      'scan-1', caller, 'consensus',
    );
    const texts = getClaimIndex().search(caller, {}).map((r) => r.originalText);
    expect(texts).toEqual([PLAIN]);
  });

  it('CI-5. analytics claim categories count the caller\'s own claims only', async () => {
    const a = getKeyStore().create('A', ['scan']);
    const b = getKeyStore().create('B', ['scan']);
    await scanAs(a.key, 'input one');
    const res = await get('/analytics/overview', b.key);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).claimCategories).toEqual([]);
  });
});
