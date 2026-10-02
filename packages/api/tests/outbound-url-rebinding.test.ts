/**
 * DNS rebinding (TOCTOU) on the outbound URL guard — real sockets, no mocked fetch.
 *
 * Every test here runs the production path: the test-only private override is
 * off and no fetch seam is set, so requests go through undici's fetch on the
 * guarded Agent. DNS is the injected resolver (no real lookups); the servers are
 * real loopback listeners that count every TCP connection they accept, so "no
 * socket to the private address" is observed, not inferred.
 *
 * Validates: N-234 (beta gate, security evidence: DNS rebinding residual closed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchOutbound,
  fetchOutboundFollow,
  OutboundUrlBlockedError,
  resetBlockedAddressPolicy,
  resetOutboundFetch,
  resetOutboundResolver,
  setBlockedAddressPolicy,
  setOutboundResolver,
  type ResolvedAddress,
} from '../src/lib/outbound-url.js';

const PUBLIC_V4 = '93.184.216.34';

interface CountingServer {
  server: Server;
  port: number;
  connections: number;
  requests: Array<{ url: string | undefined; headers: IncomingHttpHeaders }>;
}

/** A loopback HTTP server that records every accepted connection and request. */
async function startCountingServer(
  host: string,
  respond: (res: import('node:http').ServerResponse, port: number) => void,
  port = 0,
): Promise<CountingServer> {
  const state: CountingServer = { server: createServer(), port: 0, connections: 0, requests: [] };
  state.server.on('connection', () => { state.connections++; });
  state.server.on('request', (req, res) => {
    state.requests.push({ url: req.url, headers: req.headers });
    respond(res, state.port);
  });
  await new Promise<void>((resolve) => state.server.listen(port, host, resolve));
  state.port = (state.server.address() as AddressInfo).port;
  return state;
}

async function stop(state: CountingServer): Promise<void> {
  state.server.closeAllConnections();
  await new Promise<void>((resolve) => state.server.close(() => resolve()));
}

/** Resolver that answers `answers[n]` on the n-th call (last answer repeats). */
function resolveInSequence(...answers: string[][]): ReturnType<typeof vi.fn> {
  let call = 0;
  const resolver = vi.fn(async (): Promise<ResolvedAddress[]> => {
    const answer = answers[Math.min(call++, answers.length - 1)];
    return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });
  setOutboundResolver(resolver);
  return resolver;
}

const ok = (res: import('node:http').ServerResponse): void => { res.end('reached'); };

beforeEach(() => {
  vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '');
  resetOutboundFetch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOutboundResolver();
  resetBlockedAddressPolicy();
});

describe('connect-time lookup closes DNS rebinding', () => {
  let target: CountingServer;
  beforeEach(async () => { target = await startCountingServer('127.0.0.1', ok); });
  afterEach(async () => { await stop(target); });

  it('RB-01 public answer to the pre-check, loopback answer to the connect → refused, zero sockets', async () => {
    const resolver = resolveInSequence([PUBLIC_V4], ['127.0.0.1']);
    const attempt = fetchOutbound(`http://rebind.test:${target.port}/hook`, { method: 'POST', body: 'x' });
    await expect(attempt).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    await expect(attempt).rejects.toThrow(/rebind\.test resolves to a private or reserved address \(127\.0\.0\.1\)/);
    expect(resolver).toHaveBeenCalledTimes(2); // pre-check + connect-time lookup
    expect(target.connections).toBe(0);
    expect(target.requests).toHaveLength(0);
  });

  it('RB-02 connect-time answer mixing a public and a loopback address → refused, zero sockets', async () => {
    resolveInSequence([PUBLIC_V4], [PUBLIC_V4, '127.0.0.1']);
    const attempt = fetchOutbound(`http://mixed.test:${target.port}/`, { method: 'POST' });
    await expect(attempt).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    expect(target.connections).toBe(0);
  });

  it('RB-03 connect-time resolver failure → refused as unresolvable, zero sockets', async () => {
    let call = 0;
    setOutboundResolver(async () => {
      if (call++ === 0) return [{ address: PUBLIC_V4, family: 4 }];
      throw new Error('SERVFAIL');
    });
    await expect(fetchOutbound(`http://flaky.test:${target.port}/`, { method: 'POST' }))
      .rejects.toThrow(/flaky\.test could not be resolved/);
    expect(target.connections).toBe(0);
  });

  it('RB-04 a literal private IP is still refused before any socket', async () => {
    const resolver = resolveInSequence([PUBLIC_V4]);
    await expect(fetchOutbound(`http://127.0.0.1:${target.port}/`, { method: 'POST' }))
      .rejects.toBeInstanceOf(OutboundUrlBlockedError);
    expect(resolver).not.toHaveBeenCalled();
    expect(target.connections).toBe(0);
  });
});

describe('vetted requests connect to the vetted address', () => {
  let target: CountingServer;
  beforeEach(async () => {
    // Treat 127.0.0.1 as public so a real loopback server can stand in for one.
    setBlockedAddressPolicy((address) => address !== '127.0.0.1');
    target = await startCountingServer('127.0.0.1', ok);
  });
  afterEach(async () => { await stop(target); });

  it('RB-05 a name with no real DNS reaches the server through the injected connect-time answer', async () => {
    const resolver = resolveInSequence(['127.0.0.1']);
    const res = await fetchOutbound(`http://vetted.test:${target.port}/hook?q=1`, { method: 'POST', body: 'payload' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('reached');
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenNthCalledWith(2, 'vetted.test');
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]?.url).toBe('/hook?q=1');
    expect(target.requests[0]?.headers.host).toBe(`vetted.test:${target.port}`); // Host stays the name, not the IP
  });

  it('RB-06 fetchOutbound returns a 3xx without requesting the Location (undici redirect: manual)', async () => {
    await stop(target);
    target = await startCountingServer('127.0.0.1', (res, port) => {
      res.writeHead(302, { location: `http://vetted.test:${port}/elsewhere` }).end();
    });
    resolveInSequence(['127.0.0.1']);
    const res = await fetchOutbound(`http://vetted.test:${target.port}/hook`, { method: 'POST', redirect: 'follow' });
    expect(res.status).toBe(302);
    expect(target.requests.map((r) => r.url)).toEqual(['/hook']);
  });
});

describe('fetchOutboundFollow: a redirect hop that rebinds is refused', () => {
  let start: CountingServer;
  let privateTarget: CountingServer;
  beforeEach(async () => {
    // 127.0.0.1 stands in for a public host; 127.0.0.2 stays in the blocked loopback range.
    setBlockedAddressPolicy((address) => address !== '127.0.0.1');
    privateTarget = await startCountingServer('127.0.0.2', ok);
    start = await startCountingServer('127.0.0.1', (res) => {
      res.writeHead(302, { location: `http://hop.test:${privateTarget.port}/secret` }).end();
    });
  });
  afterEach(async () => {
    await stop(start);
    await stop(privateTarget);
  });

  it('RB-07 hop 2 answers public to its pre-check and private to its connect → refused, zero sockets at the private address', async () => {
    let hopCalls = 0;
    setOutboundResolver(async (host: string): Promise<ResolvedAddress[]> => {
      if (host === 'start.test') return [{ address: '127.0.0.1', family: 4 }];
      return [{ address: hopCalls++ === 0 ? '127.0.0.1' : '127.0.0.2', family: 4 }];
    });
    const attempt = fetchOutboundFollow(`http://start.test:${start.port}/page`, { method: 'GET' });
    await expect(attempt).rejects.toThrow(/hop\.test resolves to a private or reserved address \(127\.0\.0\.2\)/);
    expect(start.requests.map((r) => r.url)).toEqual(['/page']);
    expect(hopCalls).toBe(2);
    expect(privateTarget.connections).toBe(0);
  });
});
