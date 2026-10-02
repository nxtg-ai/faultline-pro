/**
 * Provider plugin endpoints are caller-supplied URLs (admin-only SSRF): the
 * endpoint is guarded at registration and again on every verify call.
 *
 * The suite-wide test override is removed so the real checks run; DNS is the
 * injected resolver and the network is the fetch seam (or, for the real-socket
 * case, a counting loopback server).
 *
 * Validates: N-234 (beta gate, security evidence: provider plugin SSRF fixed).
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { getProviderRegistry, resetProviderRegistry } from '../src/store/providers.js';
import {
  OutboundUrlBlockedError,
  resetOutboundFetch,
  resetOutboundResolver,
  setOutboundFetch,
  type OutboundFetch,
  setOutboundResolver,
  type ResolvedAddress,
} from '../src/lib/outbound-url.js';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({ overallRisk: 'low', claims: [], verifications: {} }),
}));

const ADMIN = 'admin-secret';
const HEADERS = { 'x-api-key': ADMIN, 'content-type': 'application/json' };
const PUBLIC_V4 = '93.184.216.34';

let fetchSpy: Mock<OutboundFetch>;

function resolveAllTo(address: string): void {
  setOutboundResolver(async (): Promise<ResolvedAddress[]> => [{ address, family: address.includes(':') ? 6 : 4 }]);
}

beforeEach(() => {
  process.env.FAULTLINE_API_KEY = ADMIN;
  resetKeyStore();
  resetProviderRegistry();
  vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '');
  resolveAllTo(PUBLIC_V4);
  fetchSpy = vi.fn<OutboundFetch>().mockResolvedValue(Response.json({ status: 'supported', explanation: 'ok', confidence: 0.9 }));
  setOutboundFetch(fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetOutboundFetch();
  resetOutboundResolver();
  delete process.env.FAULTLINE_API_KEY;
});

describe('POST /providers/register guards the endpoint', () => {
  let server: FastifyInstance;
  beforeEach(async () => { server = buildServer(); await server.ready(); });
  afterEach(async () => { await server.close(); });

  async function register(endpoint: string) {
    return server.inject({ method: 'POST', url: '/providers/register', headers: HEADERS, payload: { name: 'probe', endpoint } });
  }

  it('PO-01 endpoint at the metadata address → 400 with the guard message, nothing registered', async () => {
    const res = await register('http://169.254.169.254/latest/meta-data/');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^endpoint: Outbound URL blocked: .*169\.254\.169\.254/);
    expect(getProviderRegistry().getPlugin('probe')).toBeUndefined();
    expect(getProviderRegistry().getProvider('probe')).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('PO-02 endpoint on a name that resolves into the Fly private network → 400', async () => {
    resolveAllTo('fdaa::3');
    const res = await register('https://verifier.example.com/v');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^endpoint: Outbound URL blocked: .*fdaa::3/);
    expect(getProviderRegistry().getPlugin('probe')).toBeUndefined();
  });

  it('PO-03 a public endpoint registers (201)', async () => {
    const res = await register('https://verifier.example.com/v');
    expect(res.statusCode).toBe(201);
    expect(getProviderRegistry().getPlugin('probe')?.endpoint).toBe('https://verifier.example.com/v');
  });
});

describe('plugin verify sends through the guarded fetch', () => {
  it('PO-04 verify posts the claim with redirect: manual to the registered endpoint', async () => {
    getProviderRegistry().registerPlugin({ name: 'probe', endpoint: 'https://verifier.example.com/v', authHeader: 'Bearer t' });
    const result = await getProviderRegistry().getProvider('probe')!.verify('The sky is blue.');
    expect(result.status).toBe('supported');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://verifier.example.com/v');
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ claim: 'The sky is blue.' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });

  it('PO-05 endpoint public at registration, private at verify time → refused, fetch never called', async () => {
    getProviderRegistry().registerPlugin({ name: 'probe', endpoint: 'https://verifier.example.com/v' });
    resolveAllTo('169.254.169.254');
    await expect(getProviderRegistry().getProvider('probe')!.verify('claim'))
      .rejects.toBeInstanceOf(OutboundUrlBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('PO-06 real undici path: a verify target that rebinds to loopback at connect gets no socket', async () => {
    resetOutboundFetch();
    let connections = 0;
    const target: Server = createServer((_req, res) => res.end('{}'));
    target.on('connection', () => { connections++; });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const port = (target.address() as AddressInfo).port;
    try {
      let call = 0;
      setOutboundResolver(async () => [{ address: call++ === 0 ? PUBLIC_V4 : '127.0.0.1', family: 4 }]);
      getProviderRegistry().registerPlugin({ name: 'probe', endpoint: `http://verifier.test:${port}/v` });
      await expect(getProviderRegistry().getProvider('probe')!.verify('claim'))
        .rejects.toThrow(/verifier\.test resolves to a private or reserved address \(127\.0\.0\.1\)/);
      expect(connections).toBe(0);
    } finally {
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});
