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

const BLOCKED_IPV4_SUBNETS: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

// ::ffff:0:0/96 (IPv4-mapped) and 64:ff9b::/96 (NAT64) embed an IPv4 address.
// They are blocked as whole ranges so the result does not depend on whether this
// Node version's BlockList maps them onto the IPv4 rules. A public IPv4 written in
// mapped form is also refused; callers can use the plain IPv4 form.
const BLOCKED_IPV6_SUBNETS: ReadonlyArray<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

// Two lists, one per family. Node's BlockList also tests an IPv4 address against
// IPv6 rules in its ::ffff: form, so a single list holding ::ffff:0:0/96 would
// refuse every IPv4 address.
const ipv4BlockList = buildBlockList(BLOCKED_IPV4_SUBNETS, 'ipv4');
const ipv6BlockList = buildBlockList(BLOCKED_IPV6_SUBNETS, 'ipv6');

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
  if (family === 4) return ipv4BlockList.check(address, 'ipv4');
  if (family === 6) return ipv6BlockList.check(stripZone(address), 'ipv6');
  return true; // not an IP at all: refuse rather than guess
}

function stripZone(address: string): string {
  const zoneStart = address.indexOf('%');
  return zoneStart === -1 ? address : address.slice(0, zoneStart);
}

/**
 * The test-only escape hatch. Honoured only under a test runner, so a stray
 * env var in production cannot switch the guard off.
 */
export function isPrivateOverrideActive(): boolean {
  if (process.env.FAULTLINE_OUTBOUND_ALLOW_PRIVATE !== '1') return false;
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
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
