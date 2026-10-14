/**
 * Containment of anonymous and cross-key reads (emma-soul al:6a0c831cb6ed0d62,
 * GoPMO 1.18.11.3). The codex seat on 4d3070e found that the key check on
 * /graphql fired only on an exact `POST /graphql`: `POST /graphql?x=1` and
 * `GET /graphql?query=...` reached every resolver with no key, including
 * createKey (any permissions) and the scans query (every key's stored inputs
 * and claim text). `GET /scan/:id/graph` had no key check at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { resetCache } from '../src/store/cache.js';
import { resetScanStore, getScanStore } from '../src/store/scans.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter, getUsageMeter } from '../src/store/usage.js';
import type { FastifyInstance } from 'fastify';

const PRIVATE = 'PrivateClaimMarker 4417';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'x', provider: 'mock', claims: [], verifications: {}, overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] }, ruleFindings: [],
  }),
}));

const ADMIN = 'containment-admin-key';
const KEYS_QUERY = '{ keys { id } }';
const SCANS_QUERY = '{ scans { id input claims { text } } }';

function seedPrivateScan(keyId: string): string {
  return getScanStore().record(keyId, PRIVATE, {
    input: PRIVATE, provider: 'mock', overallRisk: 'high',
    claims: [{ id: 'c1', text: PRIVATE, type: 'fact', importance: 5 }],
    verifications: {},
  }).id;
}

describe('GraphQL needs a key on every method and URL', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    process.env.FAULTLINE_GRAPHQL = 'on'; // production keeps GraphQL off; this tests the scoped fix
    resetCache(); resetScanStore(); resetKeyStore(); resetAuditLogger(); resetUsageMeter();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    delete process.env.FAULTLINE_GRAPHQL;
  });

  const variants: Array<[string, () => Parameters<FastifyInstance['inject']>[0]]> = [
    ['POST /graphql', () => ({ method: 'POST', url: '/graphql', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: SCANS_QUERY }) })],
    ['POST /graphql?x=1', () => ({ method: 'POST', url: '/graphql?x=1', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: SCANS_QUERY }) })],
    ['POST /graphql/', () => ({ method: 'POST', url: '/graphql/', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: SCANS_QUERY }) })],
    ['GET /graphql?query=', () => ({ method: 'GET', url: `/graphql?query=${encodeURIComponent(SCANS_QUERY)}` })],
    ['POST /GRAPHQL?x=1', () => ({ method: 'POST', url: '/GRAPHQL?x=1', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: SCANS_QUERY }) })],
  ];

  it.each(variants)('GQ-1. %s with no key gets no data', async (_name, req) => {
    seedPrivateScan('someone-else');
    const res = await server.inject(req());
    expect(res.body).not.toContain(PRIVATE);
    expect([401, 404]).toContain(res.statusCode);
  });

  it('GQ-2. createKey through the query-string variant without a key mints nothing', async () => {
    const res = await server.inject({
      method: 'POST', url: '/graphql?x=1', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'mutation { createKey(name: "x", permissions: ["admin"]) { id } }' }),
    });
    expect(res.statusCode).toBe(401);
    expect(getKeyStore().list().length).toBe(0);
  });

  it('GQ-3. a non-admin key cannot create or delete keys, list keys or read the audit log', async () => {
    const plain = getKeyStore().create('plain', ['scan']);
    const h = { 'x-api-key': plain.key, 'content-type': 'application/json' };
    for (const query of [
      'mutation { createKey(name: "x", permissions: ["admin"]) { id } }',
      `mutation { deleteKey(id: "${plain.id}") }`,
      KEYS_QUERY,
      '{ audit { endpoint } }',
    ]) {
      const res = await server.inject({ method: 'POST', url: '/graphql', headers: h, body: JSON.stringify({ query }) });
      const body = JSON.parse(res.body);
      expect(body.errors?.[0]?.message, query).toMatch(/Forbidden/);
    }
    expect(getKeyStore().list().length).toBe(1);
    expect(getKeyStore().validateById(plain.id)).not.toBeNull();
  });

  it('GQ-4. a non-admin key reads only its own scans, and cannot ask for another key\'s', async () => {
    const mine = getKeyStore().create('mine', ['scan']);
    const theirs = getKeyStore().create('theirs', ['scan']);
    seedPrivateScan(theirs.id);
    const ownId = getScanStore().record(mine.id, 'my text', { input: 'my text', claims: [] }).id;
    const h = { 'x-api-key': mine.key, 'content-type': 'application/json' };

    const all = await server.inject({ method: 'POST', url: '/graphql', headers: h, body: JSON.stringify({ query: SCANS_QUERY }) });
    expect(all.body).not.toContain(PRIVATE);
    expect(JSON.parse(all.body).data.scans.map((s: { id: string }) => s.id)).toEqual([ownId]);

    const other = await server.inject({ method: 'POST', url: '/graphql', headers: h, body: JSON.stringify({ query: `{ scans(keyId: "${theirs.id}") { id input } }` }) });
    expect(other.body).not.toContain(PRIVATE);
    expect(JSON.parse(other.body).errors?.[0]?.message).toMatch(/Forbidden/);
  });

  it('GQ-5. a non-admin key cannot run paid scans through GraphQL (no rate limit or spend cap there)', async () => {
    const plain = getKeyStore().create('plain', ['scan']);
    const res = await server.inject({
      method: 'POST', url: '/graphql', headers: { 'x-api-key': plain.key, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ scan(text: "x", provider: "gemini") { id } }' }),
    });
    expect(JSON.parse(res.body).errors?.[0]?.message).toMatch(/Forbidden/);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    expect(vi.mocked(scan)).not.toHaveBeenCalled();
  });

  it('GQ-7. a non-admin key cannot run scanBatch either', async () => {
    const plain = getKeyStore().create('plain', ['scan']);
    const res = await server.inject({
      method: 'POST', url: '/graphql', headers: { 'x-api-key': plain.key, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'mutation { scanBatch(texts: ["a", "b"], provider: "gemini") { id } }' }),
    });
    expect(JSON.parse(res.body).errors?.[0]?.message).toMatch(/Forbidden/);
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    expect(vi.mocked(scan)).not.toHaveBeenCalled();
    expect(getScanStore().list(undefined, 200).length).toBe(0);
  });

  it('GQ-8. usage: a key reads its own counts and is refused another key\'s', async () => {
    const mine = getKeyStore().create('mine', ['scan']);
    const theirs = getKeyStore().create('theirs', ['scan']);
    const meter = getUsageMeter();
    meter.increment(mine.id); meter.increment(theirs.id); meter.increment(theirs.id); meter.increment(theirs.id);
    const h = { 'x-api-key': mine.key, 'content-type': 'application/json' };
    const own = await server.inject({ method: 'POST', url: '/graphql', headers: h, body: JSON.stringify({ query: `{ usage(keyId: "${mine.id}") { date count } }` }) });
    expect(JSON.parse(own.body).data.usage.reduce((n: number, d: { count: number }) => n + d.count, 0)).toBe(1);
    const other = await server.inject({ method: 'POST', url: '/graphql', headers: h, body: JSON.stringify({ query: `{ usage(keyId: "${theirs.id}") { date count } }` }) });
    const body = JSON.parse(other.body);
    expect(body.errors?.[0]?.message).toMatch(/Forbidden/);
    expect(JSON.stringify(body.data ?? {})).not.toContain('"count":3');
  });

  it('GQ-6. the server key still works', async () => {
    seedPrivateScan('someone');
    const res = await server.inject({ method: 'POST', url: '/graphql', headers: { 'x-api-key': ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ query: SCANS_QUERY }) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(PRIVATE);
  });
});

describe('GET /scan/:id/graph needs a key and the scan\'s own key', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    resetScanStore(); resetKeyStore();
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('GR-1. no key, a wrong key, or another key: no claim text', async () => {
    const owner = getKeyStore().create('owner', ['scan']);
    const other = getKeyStore().create('other', ['scan']);
    const id = seedPrivateScan(owner.id);
    for (const headers of [{}, { 'x-api-key': 'wrong' }, { 'x-api-key': other.key }]) {
      const res = await server.inject({ method: 'GET', url: `/scan/${id}/graph`, headers });
      expect([401, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain('PrivateClaimMarker');
    }
    const own = await server.inject({ method: 'GET', url: `/scan/${id}/graph`, headers: { 'x-api-key': owner.key } });
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain('PrivateClaimMarker');
  });
});

describe('every claim data route needs a key', () => {
  it.each(['/claims', '/claims?text=a', '/claims/trending', '/claims/stats', '/claims/x/attribution', '/claims/x/explain'])('CL-1. GET %s with no key or a wrong key is 401', async (url) => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    const server = buildServer();
    const none = await server.inject({ method: 'GET', url });
    const wrong = await server.inject({ method: 'GET', url, headers: { 'x-api-key': 'wrong' } });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    expect(none.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });
});

describe('the claim viewer sends a key', () => {
  it('CV-1. /claims/view stays public and its script sends x-api-key', async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    const server = buildServer();
    const res = await server.inject({ method: 'GET', url: '/claims/view' });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    expect(res.statusCode).toBe(200);
    const script = res.body.match(/<script>([\s\S]*?)<\/script>/)![1];
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("'x-api-key': apiKey()");
    expect(script).not.toMatch(/fetch\('\/claims/);
  });
});
