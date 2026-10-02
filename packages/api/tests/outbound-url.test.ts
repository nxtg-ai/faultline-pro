/**
 * Outbound URL guard — unit tests (CodeQL #5, SSRF).
 *
 * The suite-wide FAULTLINE_OUTBOUND_ALLOW_PRIVATE=1 (vitest.config.ts) is removed
 * here so every real check runs. DNS is always the injected resolver: no test in
 * this file touches the network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  assertSafeOutboundUrl,
  fetchOutbound,
  isBlockedAddress,
  isPrivateOverrideActive,
  outboundUrlRefusal,
  OutboundUrlBlockedError,
  resetOutboundResolver,
  setOutboundResolver,
  type ResolvedAddress,
} from '../src/lib/outbound-url.js';

const PUBLIC_V4 = '93.184.216.34';

function resolveTo(...addresses: string[]): ReturnType<typeof vi.fn> {
  const resolver = vi.fn(async (): Promise<ResolvedAddress[]> =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );
  setOutboundResolver(resolver);
  return resolver;
}

async function expectBlocked(raw: string, reason?: RegExp): Promise<void> {
  const attempt = assertSafeOutboundUrl(raw);
  await expect(attempt).rejects.toBeInstanceOf(OutboundUrlBlockedError);
  if (reason) await expect(assertSafeOutboundUrl(raw)).rejects.toThrow(reason);
}

beforeEach(() => {
  vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '');
  resolveTo(PUBLIC_V4);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetOutboundResolver();
});

describe('assertSafeOutboundUrl — blocked IPv4 literals (one per range)', () => {
  const cases: Array<[string, string]> = [
    ['0.0.0.0/8', '0.1.2.3'],
    ['10/8', '10.20.30.40'],
    ['100.64/10 low', '100.64.0.1'],
    ['100.64/10 high', '100.127.255.254'],
    ['127/8', '127.0.0.1'],
    ['127/8 non-.1', '127.45.6.7'],
    ['169.254/16 metadata', '169.254.169.254'],
    ['172.16/12 low', '172.16.0.1'],
    ['172.16/12 high', '172.31.255.254'],
    ['192.0.0/24', '192.0.0.8'],
    ['192.168/16', '192.168.1.1'],
    ['198.18/15 low', '198.18.0.1'],
    ['198.18/15 high', '198.19.255.254'],
    ['224/4 multicast', '224.0.0.251'],
    ['240/4 reserved', '240.1.2.3'],
    ['broadcast', '255.255.255.255'],
  ];
  it.each(cases)('%s (%s) is refused without DNS', async (_label, ip) => {
    const resolver = resolveTo(PUBLIC_V4);
    await expectBlocked(`http://${ip}/latest/meta-data/`, /private or reserved address/);
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('assertSafeOutboundUrl — range edges that must stay allowed', () => {
  const allowed = ['11.0.0.1', '100.63.255.254', '100.128.0.1', '172.15.255.254', '172.32.0.1', '192.0.1.1', '192.169.0.1', '198.17.255.254', '198.20.0.1', '223.255.255.254', '8.8.8.8'];
  it.each(allowed)('%s passes', async (ip) => {
    const url = await assertSafeOutboundUrl(`https://${ip}/hook`);
    expect(url.hostname).toBe(ip);
  });
});

describe('assertSafeOutboundUrl — blocked IPv6 literals', () => {
  const cases: Array<[string, string]> = [
    ['unspecified', '[::]'],
    ['loopback', '[::1]'],
    ['IPv4-mapped loopback (dotted)', '[::ffff:127.0.0.1]'],
    ['IPv4-mapped metadata (dotted)', '[::ffff:169.254.169.254]'],
    ['IPv4-mapped loopback (hex)', '[::ffff:7f00:1]'],
    ['IPv4-mapped private', '[::ffff:10.0.0.1]'],
    ['NAT64 to metadata', '[64:ff9b::a9fe:a9fe]'],
    ['Fly private network fdaa::/16', '[fdaa:0:1:a7b:1::2]'],
    ['ULA fc00::/7', '[fc00::1]'],
    ['link-local fe80::/10', '[fe80::1]'],
    ['multicast ff00::/8', '[ff02::1]'],
  ];
  it.each(cases)('%s %s is refused without DNS', async (_label, host) => {
    const resolver = resolveTo(PUBLIC_V4);
    await expectBlocked(`http://${host}:3000/`, /private or reserved address/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('a public IPv6 literal passes', async () => {
    const url = await assertSafeOutboundUrl('https://[2606:4700:4700::1111]/hook');
    expect(url.hostname).toBe('[2606:4700:4700::1111]');
  });
});

describe('assertSafeOutboundUrl — private host names', () => {
  const names = ['localhost', 'LOCALHOST', 'localhost.', 'api.localhost', 'faultline-api.internal', 'internal', 'my-app.flycast', 'printer.local', 'Printer.Local.'];
  it.each(names)('%s is refused before DNS', async (host) => {
    const resolver = resolveTo(PUBLIC_V4);
    await expectBlocked(`http://${host}:3000/x`, /private or internal name/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('a name that only contains a blocked word is not refused for it', async () => {
    resolveTo(PUBLIC_V4);
    const url = await assertSafeOutboundUrl('https://internal-tools.example.com/hook');
    expect(url.hostname).toBe('internal-tools.example.com');
  });
});

describe('assertSafeOutboundUrl — scheme, credentials, malformed', () => {
  it.each(['ftp://example.com/x', 'file:///etc/passwd', 'gopher://example.com:70/', 'javascript:alert(1)', 'data:text/plain,hi'])(
    '%s is refused for its scheme',
    async (raw) => { await expectBlocked(raw, /scheme .* is not allowed/); },
  );

  it.each(['https://user:pass@example.com/hook', 'https://user@example.com/hook', 'https://:pass@example.com/hook'])(
    '%s is refused for embedded credentials',
    async (raw) => { await expectBlocked(raw, /embedded credentials/); },
  );

  it('an unparseable URL is refused', async () => {
    await expectBlocked('not a url', /not a valid URL/);
  });
});

describe('assertSafeOutboundUrl — DNS resolution', () => {
  it('a name resolving only to public addresses passes and returns the parsed URL', async () => {
    const resolver = resolveTo(PUBLIC_V4, '2606:2800:220:1:248:1893:25c8:1946');
    const url = await assertSafeOutboundUrl('https://hooks.example.com/path?q=1');
    expect(url.href).toBe('https://hooks.example.com/path?q=1');
    expect(resolver).toHaveBeenCalledWith('hooks.example.com');
  });

  it('ANY private address in the answer set refuses the URL (mixed public + private)', async () => {
    resolveTo(PUBLIC_V4, '10.0.0.5');
    await expectBlocked('https://rebind.example.com/', /resolves to a private or reserved address \(10\.0\.0\.5\)/);
  });

  it('a name resolving to the metadata address is refused', async () => {
    resolveTo('169.254.169.254');
    await expectBlocked('http://metadata.example.com/latest/meta-data/');
  });

  it('a name resolving to an IPv4-mapped loopback is refused', async () => {
    resolveTo('::ffff:127.0.0.1');
    await expectBlocked('https://mapped.example.com/');
  });

  it('a name resolving to a Fly 6PN address is refused', async () => {
    resolveTo('fdaa:0:1:a7b:1::2');
    await expectBlocked('https://sixpn.example.com/');
  });

  it('a resolver failure refuses the URL', async () => {
    setOutboundResolver(async () => { throw new Error('ENOTFOUND'); });
    await expectBlocked('https://nxdomain.example.com/', /could not be resolved/);
  });

  it('an empty answer set refuses the URL', async () => {
    setOutboundResolver(async () => []);
    await expectBlocked('https://empty.example.com/', /no addresses/);
  });
});

describe('isBlockedAddress', () => {
  it('refuses input that is not an IP address', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
  });
  it('refuses a zoned link-local address', () => {
    expect(isBlockedAddress('fe80::1%eth0')).toBe(true);
  });
  it('allows a public IPv4 address', () => {
    expect(isBlockedAddress(PUBLIC_V4)).toBe(false);
  });
});

describe('test-only override', () => {
  it('is active only when set to 1 under a test runner', () => {
    vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '1');
    expect(isPrivateOverrideActive()).toBe(true);
  });

  it('is ignored outside a test runner (production)', async () => {
    vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '1');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', '');
    expect(isPrivateOverrideActive()).toBe(false);
    await expectBlocked('http://169.254.169.254/');
  });

  it('is ignored for any value other than 1', () => {
    vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', 'true');
    expect(isPrivateOverrideActive()).toBe(false);
  });

  it('allows a loopback URL when active', async () => {
    vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '1');
    const url = await assertSafeOutboundUrl('http://127.0.0.1:1/');
    expect(url.port).toBe('1');
  });

  it('still refuses a non-http scheme and credentials when active', async () => {
    vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '1');
    await expectBlocked('file:///etc/passwd');
    await expectBlocked('http://u:p@127.0.0.1/');
  });
});

describe('outboundUrlRefusal', () => {
  it('returns the guard message for a refused URL', async () => {
    expect(await outboundUrlRefusal('http://169.254.169.254/')).toMatch(/^Outbound URL blocked: /);
  });
  it('returns null for a safe URL', async () => {
    expect(await outboundUrlRefusal('https://hooks.example.com/')).toBeNull();
  });
});

describe('fetchOutbound', () => {
  it('never calls fetch for a refused URL', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchOutbound('http://169.254.169.254/', { method: 'POST' })).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls fetch with the original URL and redirect: manual for a safe URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    await fetchOutbound('https://hooks.example.com', { method: 'POST', redirect: 'follow' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://hooks.example.com');
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('POST');
  });
});
