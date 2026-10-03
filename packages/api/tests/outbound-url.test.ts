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
  resetOutboundFetch,
  resetOutboundResolver,
  setOutboundFetch,
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
  resetOutboundFetch();
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

// IANA special-purpose registries (updated 2025-10-09), codex al:d9dff4d8f98c5bc2 finding 3.
// One address inside each added block and, where meaningful, one just outside it.
describe('isBlockedAddress — IANA special-purpose blocks (inside)', () => {
  const inside: Array<[string, string]> = [
    ['192.0.2.0/24 TEST-NET-1 (codex)', '192.0.2.1'],
    ['192.0.2.0/24 TEST-NET-1 last', '192.0.2.255'],
    ['198.51.100.0/24 TEST-NET-2 (codex)', '198.51.100.1'],
    ['198.51.100.0/24 TEST-NET-2 last', '198.51.100.255'],
    ['203.0.113.0/24 TEST-NET-3 (codex)', '203.0.113.1'],
    ['203.0.113.0/24 TEST-NET-3 last', '203.0.113.255'],
    ['192.88.99.0/24 6to4 relay anycast', '192.88.99.1'],
    ['192.88.99.2/32 6a44 relay', '192.88.99.2'],
    ['192.0.0.0/24 non-exception .11', '192.0.0.11'],
    ['192.0.0.170 NAT64 discovery', '192.0.0.170'],
    ['192.0.0.171 NAT64 discovery', '192.0.0.171'],
    ['0.0.0.0/32 this host', '0.0.0.0'],
    ['2001:db8::/32 documentation (codex)', '2001:db8::1'],
    ['2001:db8::/32 documentation last', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['64:ff9b:1::/48 local-use NAT64', '64:ff9b:1::1'],
    ['64:ff9b:1::/48 local-use NAT64 last', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff'],
    ['100::/64 discard-only', '100::1'],
    ['100:0:0:1::/64 dummy prefix', '100:0:0:1::1'],
    ['2001::/32 TEREDO', '2001::1'],
    ['2001::/32 TEREDO embedding 127.0.0.1', '2001:0:4136:e378:8000:63bf:80ff:fffe'],
    ['2001:1::4 (not one of the three anycast exceptions)', '2001:1::4'],
    ['2001:2::/48 benchmarking', '2001:2::1'],
    ['2001:4:113:: next to AS112-v6', '2001:4:113::1'],
    ['2001:10::/28 deprecated ORCHID', '2001:10::1'],
    ['2001:40:: after DETs', '2001:40::1'],
    ['2001::/23 last address', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2002::/16 6to4 embedding 127.0.0.1', '2002:7f00:1::1'],
    ['2002::/16 6to4 embedding metadata', '2002:a9fe:a9fe::1'],
    ['3fff::/20 documentation', '3fff::1'],
    ['3fff::/20 documentation last', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['5f00::/16 SRv6 SIDs', '5f00::1'],
  ];
  it.each(inside)('%s (%s) is blocked', (_label, ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['192.0.2.1'],
    ['198.51.100.1'],
    ['203.0.113.1'],
    ['[2001:db8::1]'],
  ])('codex finding: URL with %s is refused before DNS', async (host) => {
    const resolver = resolveTo(PUBLIC_V4);
    await expectBlocked(`http://${host}/`, /private or reserved address/);
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('isBlockedAddress — just outside the added blocks, and registry exceptions (allowed)', () => {
  const outside: Array<[string, string]> = [
    ['before 192.0.2.0/24', '192.0.1.255'],
    ['after 192.0.2.0/24', '192.0.3.0'],
    ['before 198.51.100.0/24', '198.51.99.255'],
    ['after 198.51.100.0/24', '198.51.101.0'],
    ['before 203.0.113.0/24', '203.0.112.255'],
    ['after 203.0.113.0/24', '203.0.114.0'],
    ['before 192.88.99.0/24', '192.88.98.255'],
    ['after 192.88.99.0/24', '192.88.100.0'],
    ['registry GR: 192.0.0.9 PCP anycast', '192.0.0.9'],
    ['registry GR: 192.0.0.10 TURN anycast', '192.0.0.10'],
    ['registry GR: 192.31.196.0/24 AS112-v4', '192.31.196.1'],
    ['before 2001:db8::/32', '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['after 2001:db8::/32', '2001:db9::1'],
    ['after 64:ff9b:1::/48', '64:ff9b:2::1'],
    ['after 100:0:0:1::/64', '100:0:0:2::1'],
    ['after 2001::/23', '2001:200::1'],
    ['registry GR: 2001:1::1 PCP anycast', '2001:1::1'],
    ['registry GR: 2001:1::2 TURN anycast', '2001:1::2'],
    ['registry GR: 2001:1::3 DNS-SD SRP anycast', '2001:1::3'],
    ['registry GR: 2001:3::/32 AMT', '2001:3::1'],
    ['registry GR: 2001:4:112::/48 AS112-v6', '2001:4:112::1'],
    ['registry GR: 2001:20::/28 ORCHIDv2', '2001:20::1'],
    ['registry GR: 2001:30::/28 DETs', '2001:3f:ffff::1'],
    ['registry GR: 2620:4f:8000::/48 AS112', '2620:4f:8000::1'],
    ['before 2002::/16', '2001:ffff::1'],
    ['after 2002::/16', '2003::1'],
    ['after 3fff::/20', '3fff:1000::1'],
    ['after 5f00::/16', '5f01::1'],
  ];
  it.each(outside)('%s (%s) is allowed', (_label, ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
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

  it('codex al:d9dff4d8f98c5bc2: NODE_ENV=production + VITEST=false is not a test runner', async () => {
    vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '1');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', 'false');
    expect(isPrivateOverrideActive()).toBe(false);
    await expectBlocked('http://127.0.0.1/');
  });

  it.each(['0', '1', 'TRUE', 'yes', ' true'])('VITEST=%j outside NODE_ENV=test does not activate it', (value) => {
    vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '1');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', value);
    expect(isPrivateOverrideActive()).toBe(false);
  });

  it('VITEST=true (what Vitest sets) activates it even when NODE_ENV is not test', () => {
    vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '1');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', 'true');
    expect(isPrivateOverrideActive()).toBe(true);
  });

  it('NODE_ENV=test activates it without VITEST', () => {
    vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '1');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', '');
    expect(isPrivateOverrideActive()).toBe(true);
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
    setOutboundFetch(fetchSpy);
    await expect(fetchOutbound('http://169.254.169.254/', { method: 'POST' })).rejects.toBeInstanceOf(OutboundUrlBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls fetch with the original URL and redirect: manual for a safe URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    setOutboundFetch(fetchSpy);
    await fetchOutbound('https://hooks.example.com', { method: 'POST', redirect: 'follow' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://hooks.example.com');
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('POST');
  });
});
