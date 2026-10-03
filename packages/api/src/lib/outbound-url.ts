/**
 * Outbound URL guard — the single gate in front of every fetch to a URL that a
 * caller (or an operator env var) supplied. Closes CodeQL #5 (SSRF).
 *
 * A URL passes only when it is http(s), carries no credentials, does not name a
 * private host, and EVERY address it resolves to is public. A hostname with one
 * public and one private A/AAAA record is rejected, because the connect may pick
 * either.
 *
 * DNS rebinding: the guarded fetch runs on undici with an Agent whose
 * connect-time `lookup` resolves the host again, refuses the connect when ANY
 * answer is blocked, and hands the socket only the vetted addresses. The address
 * that is checked is the address that is connected, so a resolver that answers
 * public to the pre-check and private to the connect gets no socket. See
 * docs/security/2026-10-02-security-evidence-v0.11.1.md.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

/** Thrown when a URL must not be fetched. The message is safe to return to a caller. */
export class OutboundUrlBlockedError extends Error {
  constructor(reason: string) {
    super(`Outbound URL blocked: ${reason}`);
    this.name = 'OutboundUrlBlockedError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolves a hostname to every address it maps to. Injectable so tests do no real DNS. */
export type OutboundResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultResolver: OutboundResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

let resolver: OutboundResolver = defaultResolver;

export function setOutboundResolver(fn: OutboundResolver): void {
  resolver = fn;
}

export function resetOutboundResolver(): void {
  resolver = defaultResolver;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.internal', '.flycast', '.local'];

// Blocked ranges follow the IANA special-purpose address registries:
//   https://www.iana.org/assignments/iana-ipv4-special-registry (updated 2025-10-09)
//   https://www.iana.org/assignments/iana-ipv6-special-registry (updated 2025-10-09)
// Every block whose "Globally Reachable" column is False, blank or N/A is listed,
// plus multicast. Blocks the registry marks globally reachable that sit INSIDE a
// non-reachable parent are carved back out in the *_GLOBAL_EXCEPTIONS tables.
// Policy: enumeration of the registries, not a global-unicast allow list.
const BLOCKED_IPV4_SUBNETS: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // "This network" (RFC 791); contains 0.0.0.0/32
  ['10.0.0.0', 8], // Private-Use (RFC 1918)
  ['100.64.0.0', 10], // Shared Address Space, CGNAT (RFC 6598)
  ['127.0.0.0', 8], // Loopback (RFC 1122)
  ['169.254.0.0', 16], // Link Local, cloud metadata (RFC 3927)
  ['172.16.0.0', 12], // Private-Use (RFC 1918)
  ['192.0.0.0', 24], // IETF Protocol Assignments (RFC 6890); contains /29, .8, .170, .171
  ['192.0.2.0', 24], // Documentation TEST-NET-1 (RFC 5737)
  ['192.88.99.0', 24], // Deprecated 6to4 Relay Anycast (RFC 7526); contains 192.88.99.2/32
  ['192.168.0.0', 16], // Private-Use (RFC 1918)
  ['198.18.0.0', 15], // Benchmarking (RFC 2544)
  ['198.51.100.0', 24], // Documentation TEST-NET-2 (RFC 5737)
  ['203.0.113.0', 24], // Documentation TEST-NET-3 (RFC 5737)
  ['224.0.0.0', 4], // Multicast (IANA multicast registry, RFC 5771)
  ['240.0.0.0', 4], // Reserved (RFC 1112)
  ['255.255.255.255', 32], // Limited Broadcast (RFC 919); inside 240/4, listed for the record
];

// Globally reachable per the registry, inside a blocked parent above.
const IPV4_GLOBAL_EXCEPTIONS: ReadonlyArray<[string, number]> = [
  ['192.0.0.9', 32], // Port Control Protocol Anycast (RFC 7723)
  ['192.0.0.10', 32], // Traversal Using Relays around NAT Anycast (RFC 8155)
];

// ::ffff:0:0/96 (IPv4-mapped), 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64) and
// 2002::/16 (6to4) embed an IPv4 address, so each can name a private IPv4 host
// (2002:7f00:1:: is 127.0.0.1). They are blocked as whole ranges, which is
// stricter than the registry for 64:ff9b::/96 (globally reachable there) and
// 2002::/16 (N/A there). A public IPv4 written in one of these forms is refused;
// callers can use the plain IPv4 form.
const BLOCKED_IPV6_SUBNETS: ReadonlyArray<[string, number]> = [
  ['::', 128], // Unspecified (RFC 4291)
  ['::1', 128], // Loopback (RFC 4291)
  ['::ffff:0:0', 96], // IPv4-mapped (RFC 4291)
  ['64:ff9b::', 96], // IPv4-IPv6 translation (RFC 6052), embeds IPv4: blocked by policy
  ['64:ff9b:1::', 48], // Local-use IPv4-IPv6 translation (RFC 8215)
  ['100::', 64], // Discard-Only (RFC 6666)
  ['100:0:0:1::', 64], // Dummy IPv6 Prefix (RFC 9780)
  // IETF Protocol Assignments (RFC 2928). Contains TEREDO 2001::/32 (N/A, embeds
  // an obfuscated IPv4), Benchmarking 2001:2::/48 and deprecated ORCHID 2001:10::/28.
  ['2001::', 23],
  ['2001:db8::', 32], // Documentation (RFC 3849)
  ['2002::', 16], // 6to4 (RFC 3056), embeds IPv4: blocked by policy
  ['3fff::', 20], // Documentation (RFC 9637)
  ['5f00::', 16], // Segment Routing SRv6 SIDs (RFC 9602)
  ['fc00::', 7], // Unique-Local (RFC 4193), includes Fly 6PN fdaa::/16
  ['fe80::', 10], // Link-Local Unicast (RFC 4291)
  ['ff00::', 8], // Multicast (RFC 4291)
];

// Globally reachable per the registry, inside 2001::/23.
const IPV6_GLOBAL_EXCEPTIONS: ReadonlyArray<[string, number]> = [
  ['2001:1::1', 128], // Port Control Protocol Anycast (RFC 7723)
  ['2001:1::2', 128], // TURN Anycast (RFC 8155)
  ['2001:1::3', 128], // DNS-SD Service Registration Protocol Anycast (RFC 9665)
  ['2001:3::', 32], // AMT (RFC 7450)
  ['2001:4:112::', 48], // AS112-v6 (RFC 7535)
  ['2001:20::', 28], // ORCHIDv2 (RFC 7343)
  ['2001:30::', 28], // Drone Remote ID Protocol Entity Tags (RFC 9374)
];

// Separate lists per family. Node's BlockList also tests an IPv4 address against
// IPv6 rules in its ::ffff: form, so a single list holding ::ffff:0:0/96 would
// refuse every IPv4 address.
const ipv4BlockList = buildBlockList(BLOCKED_IPV4_SUBNETS, 'ipv4');
const ipv6BlockList = buildBlockList(BLOCKED_IPV6_SUBNETS, 'ipv6');
const ipv4ExceptionList = buildBlockList(IPV4_GLOBAL_EXCEPTIONS, 'ipv4');
const ipv6ExceptionList = buildBlockList(IPV6_GLOBAL_EXCEPTIONS, 'ipv6');

function buildBlockList(subnets: ReadonlyArray<[string, number]>, family: 'ipv4' | 'ipv6'): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, family);
  return list;
}

/** True when an IP literal falls in a private, loopback, link-local, multicast or reserved range. */
export function isBlockedAddress(address: string): boolean {
  return blockedAddressPolicy(address);
}

/** Decides whether a resolved address may be connected to. Injectable so tests can admit a loopback server. */
export type BlockedAddressPolicy = (address: string) => boolean;

let blockedAddressPolicy: BlockedAddressPolicy = isInBlockedRange;

/** Test seam: replace the blocked-address decision (pre-check and connect-time lookup). */
export function setBlockedAddressPolicy(fn: BlockedAddressPolicy): void {
  blockedAddressPolicy = fn;
}

export function resetBlockedAddressPolicy(): void {
  blockedAddressPolicy = isInBlockedRange;
}

function isInBlockedRange(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return inBlockedSubnet(address, 'ipv4', ipv4BlockList, ipv4ExceptionList);
  if (family === 6) return inBlockedSubnet(stripZone(address), 'ipv6', ipv6BlockList, ipv6ExceptionList);
  return true; // not an IP at all: refuse rather than guess
}

function inBlockedSubnet(address: string, family: 'ipv4' | 'ipv6', blocked: BlockList, exceptions: BlockList): boolean {
  return blocked.check(address, family) && !exceptions.check(address, family);
}

function stripZone(address: string): string {
  const zoneStart = address.indexOf('%');
  return zoneStart === -1 ? address : address.slice(0, zoneStart);
}

/**
 * The test-only escape hatch. Honoured only under a test runner, so a stray
 * env var in production cannot switch the guard off. The runner check is exact:
 * Vitest sets VITEST to the string 'true'; any other value ('false', '0', ...)
 * does not count as a test runner.
 */
export function isPrivateOverrideActive(): boolean {
  if (process.env.FAULTLINE_OUTBOUND_ALLOW_PRIVATE !== '1') return false;
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new OutboundUrlBlockedError('not a valid URL');
  }
}

function assertSchemeAndCredentials(url: URL): void {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new OutboundUrlBlockedError(`scheme ${url.protocol} is not allowed (use http or https)`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new OutboundUrlBlockedError('URLs with embedded credentials are not allowed');
  }
}

/** Lowercased hostname with IPv6 brackets and a trailing root dot removed. */
function normaliseHostname(url: URL): string {
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function isBlockedHostname(host: string): boolean {
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

function assertHostnameAllowed(host: string): void {
  if (host === '') throw new OutboundUrlBlockedError('URL has no host');
  if (isBlockedHostname(host)) {
    throw new OutboundUrlBlockedError(`host ${host} is a private or internal name`);
  }
}

async function resolveAll(host: string): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new OutboundUrlBlockedError(`host ${host} could not be resolved`);
  }
  if (addresses.length === 0) throw new OutboundUrlBlockedError(`host ${host} resolved to no addresses`);
  return addresses;
}

function assertNoneBlocked(host: string, addresses: ResolvedAddress[]): void {
  const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
  if (blocked) {
    throw new OutboundUrlBlockedError(`host ${host} resolves to a private or reserved address (${blocked.address})`);
  }
}

async function assertAddressesPublic(host: string): Promise<void> {
  const addresses = isIP(host) !== 0 ? [{ address: host, family: isIP(host) }] : await resolveAll(host);
  assertNoneBlocked(host, addresses);
}

/**
 * Resolve a host at connect time and return only addresses that passed the
 * block check. Refuses the whole answer set when any address is blocked, for
 * the same reason as the pre-check: the socket may try any of them.
 */
async function resolveVetted(hostname: string, family: number | undefined): Promise<ResolvedAddress[]> {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const addresses = isIP(host) !== 0 ? [{ address: host, family: isIP(host) }] : await resolveAll(host);
  assertNoneBlocked(host, addresses);
  const wanted = family === 4 || family === 6 ? addresses.filter((entry) => entry.family === family) : addresses;
  if (wanted.length === 0) throw new OutboundUrlBlockedError(`host ${host} has no IPv${family} address`);
  return wanted;
}

/**
 * `lookup` for net/tls.connect. Node calls it with `all: true` when
 * autoSelectFamily is on (the default since Node 20) and expects an array;
 * otherwise it expects a single address and family.
 */
const vettedLookup: LookupFunction = (hostname, options, callback) => {
  const family = typeof options.family === 'number' ? options.family : undefined;
  resolveVetted(hostname, family).then(
    (addresses) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    },
    (err: unknown) => callback(toErrnoException(err), []),
  );
};

function toErrnoException(err: unknown): NodeJS.ErrnoException {
  return err instanceof Error ? err : new Error(String(err));
}

// One shared pool. The lookup reads the module's current resolver and policy on
// every connect, so the test seams steer it without rebuilding the Agent.
const guardedAgent = new Agent({ connect: { lookup: vettedLookup } });

/**
 * Validate a caller-supplied URL before any outbound request.
 *
 * @param raw - The URL exactly as the caller supplied it.
 * @returns The parsed URL when it is safe to request.
 * @throws OutboundUrlBlockedError when the URL is malformed, non-http(s), carries
 *   credentials, names a private host, or resolves to any private/reserved address.
 *
 * @example
 *   await assertSafeOutboundUrl('https://hooks.example.com/x'); // ok when public
 *   await assertSafeOutboundUrl('http://169.254.169.254/');      // throws
 */
export async function assertSafeOutboundUrl(raw: string): Promise<URL> {
  const url = parseUrl(raw);
  assertSchemeAndCredentials(url);
  if (isPrivateOverrideActive()) return url;
  const host = normaliseHostname(url);
  assertHostnameAllowed(host);
  await assertAddressesPublic(host);
  return url;
}

/**
 * Route-level form of the guard: the refusal message for a 400, or null when the
 * URL is safe. Errors other than a refusal propagate.
 */
export async function outboundUrlRefusal(raw: string): Promise<string | null> {
  try {
    await assertSafeOutboundUrl(raw);
    return null;
  } catch (err) {
    if (err instanceof OutboundUrlBlockedError) return err.message;
    throw err;
  }
}

/** The fetch the guarded helpers call. Same shape as global fetch. */
export type OutboundFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Production path: undici's own fetch on the guarded Agent. Node's global fetch
 * is never given this Agent, because its bundled undici is a different copy.
 */
const guardedFetch: OutboundFetch = async (url, init) => {
  try {
    const res = await undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher: guardedAgent });
    // undici's Response is the WHATWG Response the callers already use; only the TS types differ.
    return res as unknown as Response;
  } catch (err) {
    // A connect-time refusal surfaces as TypeError('fetch failed', { cause }).
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof OutboundUrlBlockedError) throw cause;
    throw err;
  }
};

let fetchOverride: OutboundFetch | null = null;

/** Test seam: route guarded requests to `fn` instead of the network. */
export function setOutboundFetch(fn: OutboundFetch): void {
  fetchOverride = fn;
}

export function resetOutboundFetch(): void {
  fetchOverride = null;
}

/**
 * The fetch for this call. Under the test-only private override every check is
 * already off, so suites that stub global fetch keep working; production has
 * neither seam set and always gets the guarded undici path.
 */
function selectFetch(): OutboundFetch {
  if (fetchOverride) return fetchOverride;
  if (isPrivateOverrideActive()) return (url, init) => globalThis.fetch(url, init);
  return guardedFetch;
}

/**
 * POST-style fetch to a caller-supplied URL: guard first, never follow redirects.
 * A 3xx comes back as the response status; the Location is not requested.
 *
 * @throws OutboundUrlBlockedError before any network I/O when the URL is unsafe,
 *   or at connect time when the host now resolves to a blocked address.
 */
export async function fetchOutbound(raw: string, init: RequestInit): Promise<Response> {
  await assertSafeOutboundUrl(raw);
  return selectFetch()(raw, { ...init, redirect: 'manual' });
}

/**
 * GET-style fetch of caller-supplied content (scheduled URL scans): guard the
 * URL, then follow at most `maxRedirects` redirects, guarding every Location
 * before it is requested. A redirect to a private address is refused, not
 * followed, so a public URL cannot bounce the server onto its own network.
 *
 * @throws OutboundUrlBlockedError when the URL or any redirect target is unsafe.
 */
export async function fetchOutboundFollow(raw: string, init: RequestInit, maxRedirects = 3): Promise<Response> {
  let current = raw;
  for (let hop = 0; ; hop++) {
    await assertSafeOutboundUrl(current);
    const res = await selectFetch()(current, { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return res;
    await res.body?.cancel();
    if (hop >= maxRedirects) throw new Error(`Too many redirects (more than ${maxRedirects}) from ${raw}`);
    current = new URL(location, current).toString();
  }
}
