/**
 * url-validator source probes run through the outbound URL guard — real sockets.
 *
 * The source URIs that /scan/deep HEAD-probes come from a model, so they are
 * untrusted input. Every test here runs the production path: the test-only
 * private override is off and no fetch seam is set, so the default fetcher goes
 * through fetchOutboundFollow on the guarded undici Agent. DNS is the injected
 * resolver; the servers are real loopback listeners that count every accepted
 * TCP connection, so "no socket" is observed, not inferred.
 *
 * Closes codex review al:d9dff4d8f98c5bc2 finding 1 (loopback fixture got 200
 * and one connection through raw global fetch).
 *
 * Validates: N-234 (beta gate, security evidence: outbound URL sinks guarded).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  resetBlockedAddressPolicy,
  resetOutboundFetch,
  resetOutboundResolver,
  setBlockedAddressPolicy,
  setOutboundResolver,
  type ResolvedAddress,
} from '../src/lib/outbound-url.js';
import { buildEvidenceLinks, resetUrlFetcher, validateSourceUrl } from '../src/lib/url-validator.js';
import { buildServer } from '../src/server.js';
import { clearRobotsCache, EVIDENCE_USER_AGENT } from '@nxtg/faultline/evidence/robots.js';
import { resetCache } from '../src/store/cache.js';

// The scan engine is mocked so /scan/deep returns whatever sources the "model"
// produced; each test sets them through scanSources.
const scanSources = vi.hoisted(() => ({ list: [] as Array<{ title: string; uri: string }> }));
vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn(async () => ({
    input: 'x',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'medical accuracy claim', type: 'fact', importance: 4 }],
    verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: 'e', sources: scanSources.list } },
    overallRisk: 'medium',
  })),
}));

interface CountingServer {
  server: Server;
  port: number;
  connections: number;
  requests: Array<{ method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders }>;
}

async function startCountingServer(
  host: string,
  respond: (res: ServerResponse, port: number, path: string | undefined) => void,
): Promise<CountingServer> {
  const state: CountingServer = { server: createServer(), port: 0, connections: 0, requests: [] };
  state.server.on('connection', () => { state.connections++; });
  state.server.on('request', (req, res) => {
    state.requests.push({ method: req.method, url: req.url, headers: req.headers });
    respond(res, state.port, req.url);
  });
  await new Promise<void>((resolve) => state.server.listen(0, host, resolve));
  state.port = (state.server.address() as AddressInfo).port;
  return state;
}

async function stop(state: CountingServer): Promise<void> {
  state.server.closeAllConnections();
  await new Promise<void>((resolve) => state.server.close(() => resolve()));
}

/** Resolver answering from a fixed host → address map; unknown hosts fail to resolve. */
function resolveFrom(table: Record<string, string>): ReturnType<typeof vi.fn> {
  const resolver = vi.fn(async (host: string): Promise<ResolvedAddress[]> => {
    const address = table[host];
    if (!address) throw new Error(`ENOTFOUND ${host}`);
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  });
  setOutboundResolver(resolver);
  return resolver;
}

const ok = (res: ServerResponse): void => {
  res.writeHead(200, { 'last-modified': new Date().toUTCString() }).end();
};

/** 127.0.0.1 stands in for a public host; every other address keeps the real policy. */
function admitLoopbackOneAsPublic(): void {
  setBlockedAddressPolicy((address) => address !== '127.0.0.1');
}

beforeEach(() => {
  vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '');
  resetOutboundFetch();
  resetUrlFetcher();
  clearRobotsCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOutboundResolver();
  resetBlockedAddressPolicy();
  resetUrlFetcher();
});

describe('url-validator: blocked sources get no socket and report unreachable', () => {
  let target: CountingServer;
  beforeEach(async () => { target = await startCountingServer('127.0.0.1', ok); });
  afterEach(async () => { await stop(target); });

  it('UVG-01 a model-returned 127.0.0.1 URL → no connection, status 0, available=false', async () => {
    const resolver = resolveFrom({});
    const result = await validateSourceUrl(`http://127.0.0.1:${target.port}/admin`, 'Admin', 'unrelated claim');
    expect(result).toEqual(expect.objectContaining({ statusCode: 0, available: false, evidenceScore: 0 }));
    expect(resolver).not.toHaveBeenCalled();
    expect(target.connections).toBe(0);
    expect(target.requests).toHaveLength(0);
  });

  it('UVG-02 a public-looking hostname resolving to loopback → no connection, status 0', async () => {
    const resolver = resolveFrom({ 'research.example-journal.org': '127.0.0.1' });
    const result = await validateSourceUrl(
      `http://research.example-journal.org:${target.port}/paper`, 'Paper', 'peer reviewed paper',
    );
    expect(result.statusCode).toBe(0);
    expect(result.available).toBe(false);
    expect(resolver).toHaveBeenCalledWith('research.example-journal.org');
    expect(target.connections).toBe(0);
  });
});

describe('url-validator: redirect hops are guarded one by one', () => {
  let start: CountingServer;
  let privateTarget: CountingServer | undefined;
  afterEach(async () => {
    await stop(start);
    if (privateTarget) await stop(privateTarget);
    privateTarget = undefined;
  });

  it('UVG-03 a public source redirecting to 169.254.169.254 → first hop only, reported unreachable', async () => {
    admitLoopbackOneAsPublic();
    start = await startCountingServer('127.0.0.1', (res, _port, path) => {
      if (path === '/robots.txt') { res.writeHead(404).end(); return; }
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam/' }).end();
    });
    const resolver = resolveFrom({ 'source.test': '127.0.0.1' });
    const result = await validateSourceUrl(`http://source.test:${start.port}/doc`, 'Doc', 'documented fact');
    expect(result.statusCode).toBe(0);
    expect(result.available).toBe(false);
    // robots.txt is asked first, then the page; the metadata hop is refused before its robots.txt or any socket.
    expect(start.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /robots.txt', 'HEAD /doc']);
    const looked = resolver.mock.calls.map((call) => call[0]);
    expect(looked.length).toBeGreaterThan(0);
    expect(looked.every((h) => h === 'source.test')).toBe(true);
  });

  it('UVG-04 a redirect to a hostname that resolves private → the private server sees zero connections', async () => {
    admitLoopbackOneAsPublic();
    privateTarget = await startCountingServer('127.0.0.2', ok);
    start = await startCountingServer('127.0.0.1', (res, _port, path) => {
      if (path === '/robots.txt') { res.writeHead(404).end(); return; }
      res.writeHead(301, { location: `http://internal-hop.test:${privateTarget!.port}/secret` }).end();
    });
    resolveFrom({ 'source.test': '127.0.0.1', 'internal-hop.test': '127.0.0.2' });
    const result = await validateSourceUrl(`http://source.test:${start.port}/doc`, 'Doc', 'documented fact');
    expect(result.statusCode).toBe(0);
    expect(start.requests.filter((r) => r.method === 'HEAD')).toHaveLength(1);
    expect(privateTarget.connections).toBe(0);
  });

  it('UVG-05 a public redirect to another public URL is followed and scored on the final status', async () => {
    admitLoopbackOneAsPublic();
    // One server answers both hops; the path decides redirect vs final page.
    start = await startCountingServer('127.0.0.1', (res, port, path) => {
      if (path === '/doc') res.writeHead(302, { location: `http://final.test:${port}/landing` }).end();
      else ok(res);
    });
    resolveFrom({ 'source.test': '127.0.0.1', 'final.test': '127.0.0.1' });
    const result = await validateSourceUrl(`http://source.test:${start.port}/doc`, 'Doc', 'documented fact');
    expect(result.statusCode).toBe(200);
    expect(result.available).toBe(true);
    expect(start.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /robots.txt', 'HEAD /doc', 'GET /robots.txt', 'HEAD /landing']);
  });

  it('UVG-06 more than 3 redirect hops → reported unreachable after exactly 4 requests', async () => {
    admitLoopbackOneAsPublic();
    start = await startCountingServer('127.0.0.1', (res, port) => {
      res.writeHead(302, { location: `http://loop.test:${port}/again` }).end();
    });
    resolveFrom({ 'loop.test': '127.0.0.1' });
    const result = await validateSourceUrl(`http://loop.test:${start.port}/doc`, 'Doc', 'documented fact');
    expect(result.statusCode).toBe(0);
    expect(result.available).toBe(false);
    // One robots.txt for the origin (cached), then the original request + 3 followed hops.
    expect(start.requests.filter((r) => r.method === 'HEAD')).toHaveLength(4);
    expect(start.requests.filter((r) => r.url === '/robots.txt')).toHaveLength(1);
  });
});

describe('url-validator: a normal public source still validates', () => {
  let target: CountingServer;
  beforeEach(async () => {
    admitLoopbackOneAsPublic();
    target = await startCountingServer('127.0.0.1', ok);
  });
  afterEach(async () => { await stop(target); });

  it('UVG-07 HEAD with the bot user-agent, 200, available, scored with recency', async () => {
    resolveFrom({ 'journal.test': '127.0.0.1' });
    const result = await validateSourceUrl(`http://journal.test:${target.port}/article`, 'Medical accuracy study', 'medical accuracy');
    expect(result.statusCode).toBe(200);
    expect(result.available).toBe(true);
    expect(result.lastModified).toBeDefined();
    expect(result.evidenceScore).toBe(100); // 50 available + 30 title match + 20 recency
    expect(target.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /robots.txt', 'HEAD /article']);
    // The named user agent with its contact URL, on robots.txt and on the probe.
    for (const r of target.requests) expect(r.headers['user-agent']).toBe(EVIDENCE_USER_AGENT);
  });
});

describe('url-validator: provider terms and robots.txt (emma-soul al:07b45f0562efbbf0, al:15b443bc1ccf7a4e)', () => {
  let target: CountingServer;
  afterEach(async () => { await stop(target); });

  it('UVG-10 a page robots.txt disallows is never probed: notChecked robots', async () => {
    admitLoopbackOneAsPublic();
    target = await startCountingServer('127.0.0.1', (res, _port, path) => {
      if (path === '/robots.txt') res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: FaultlineEvidence\nDisallow: /private\n');
      else ok(res);
    });
    resolveFrom({ 'journal.test': '127.0.0.1' });
    const result = await validateSourceUrl(`http://journal.test:${target.port}/private/paper`, 'Paper', 'paper');
    expect(result).toEqual(expect.objectContaining({ statusCode: 0, available: false, notChecked: 'robots' }));
    expect(target.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /robots.txt']);
  });

  it('UVG-11 a Google grounding Link is never requested: notChecked provider_terms, no lookup, no socket', async () => {
    target = await startCountingServer('127.0.0.1', ok);
    const resolver = resolveFrom({});
    const result = await validateSourceUrl('https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', 'g', 'claim');
    expect(result).toEqual(expect.objectContaining({ statusCode: 0, available: false, notChecked: 'provider_terms' }));
    expect(resolver).not.toHaveBeenCalled();
  });

  it('UVG-12 a redirect onto the Google grounding host is not followed', async () => {
    admitLoopbackOneAsPublic();
    target = await startCountingServer('127.0.0.1', (res, _port, path) => {
      if (path === '/doc') res.writeHead(302, { location: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x' }).end();
      else ok(res);
    });
    const resolver = resolveFrom({ 'source.test': '127.0.0.1' });
    const result = await validateSourceUrl(`http://source.test:${target.port}/doc`, 'Doc', 'claim');
    expect(result.notChecked).toBe('provider_terms');
    expect(resolver.mock.calls.map((c) => c[0])).not.toContain('vertexaisearch.cloud.google.com');
  });
});

describe('buildEvidenceLinks with mixed sources (the /scan/deep shape)', () => {
  let target: CountingServer;
  beforeEach(async () => {
    admitLoopbackOneAsPublic();
    target = await startCountingServer('127.0.0.1', ok);
  });
  afterEach(async () => { await stop(target); });

  it('UVG-08 blocked sources score 0 beside a public one; nothing throws, one connection total', async () => {
    resolveFrom({ 'journal.test': '127.0.0.1', 'evil.test': '10.0.0.5' });
    const links = await buildEvidenceLinks(
      [{ id: 'c1', text: 'medical accuracy claim' }],
      {
        c1: {
          sources: [
            { title: 'Medical accuracy', uri: `http://journal.test:${target.port}/ok` },
            { title: 'Metadata', uri: 'http://169.254.169.254/latest/meta-data/' },
            { title: 'Private name', uri: `http://evil.test:${target.port}/` },
            { title: 'Not http', uri: 'file:///etc/passwd' },
          ],
        },
      },
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.sources.map((s) => s.statusCode)).toEqual([200, 0, 0, 0]);
    expect(links[0]?.sources.map((s) => s.available)).toEqual([true, false, false, false]);
    expect(target.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /robots.txt', 'HEAD /ok']);
  });
});

describe('POST /scan/deep with model-returned private sources', () => {
  let target: CountingServer;
  beforeEach(async () => {
    vi.stubEnv('FAULTLINE_API_KEY', 'deep-guard-key');
    resetCache();
    target = await startCountingServer('127.0.0.1', ok);
  });
  afterEach(async () => { await stop(target); });

  it('UVG-09 returns 200 with the private sources unavailable, never a 500, and no socket opened', async () => {
    resolveFrom({ 'internal.example.com': '192.168.1.10' });
    scanSources.list = [
      { title: 'Loopback', uri: `http://127.0.0.1:${target.port}/` },
      { title: 'Metadata', uri: 'http://169.254.169.254/latest/meta-data/' },
      { title: 'Rebound name', uri: `http://internal.example.com:${target.port}/` },
    ];
    const server = buildServer();
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/scan/deep',
        headers: { 'x-api-key': 'deep-guard-key', 'content-type': 'application/json' },
        payload: JSON.stringify({ text: 'UVG-09 guarded deep scan', provider: 'mock' }),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        evidenceLinks: Array<{ sources: Array<{ statusCode: number; available: boolean }> }>;
      };
      const sources = body.evidenceLinks[0]?.sources ?? [];
      expect(sources).toHaveLength(3);
      expect(sources.every((s) => s.statusCode === 0 && !s.available)).toBe(true);
      expect(target.connections).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe('url-validator: a robots.txt that redirects to a private address', () => {
  let start: CountingServer;
  afterEach(async () => { await stop(start); });

  it('UVG-13 the robots.txt redirect is refused by the guard, and the page is not probed', async () => {
    admitLoopbackOneAsPublic();
    start = await startCountingServer('127.0.0.1', (res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    });
    resolveFrom({ 'source.test': '127.0.0.1' });
    const result = await validateSourceUrl(`http://source.test:${start.port}/doc`, 'Doc', 'claim');
    expect(result.statusCode).toBe(0);
    expect(start.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /robots.txt']);
  });
});
