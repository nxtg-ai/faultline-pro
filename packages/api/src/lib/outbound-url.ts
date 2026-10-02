/**
 * Outbound URL guard — the single gate in front of every fetch to a URL that a
 * caller (or an operator env var) supplied. Closes CodeQL #5 (SSRF).
 *
 * A URL passes only when it is http(s), carries no credentials, does not name a
 * private host, and EVERY address it resolves to is public. A hostname with one
 * public and one private A/AAAA record is rejected, because the connect may pick
 * either.
 *
 * Residual (documented, not solved): the check resolves DNS, then fetch resolves
 * again. A rebinding DNS server can answer public to the check and private to the
 * connect. See docs/security/2026-10-02-security-evidence-v0.11.1.md.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

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

async function assertAddressesPublic(host: string): Promise<void> {
  const addresses = isIP(host) !== 0 ? [{ address: host, family: isIP(host) }] : await resolveAll(host);
  const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
  if (blocked) {
    throw new OutboundUrlBlockedError(`host ${host} resolves to a private or reserved address (${blocked.address})`);
  }
}

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

/**
 * POST-style fetch to a caller-supplied URL: guard first, never follow redirects.
 * A 3xx comes back as the response status; the Location is not requested.
 *
 * @throws OutboundUrlBlockedError before any network I/O when the URL is unsafe.
 */
export async function fetchOutbound(raw: string, init: RequestInit): Promise<Response> {
  await assertSafeOutboundUrl(raw);
  return fetch(raw, { ...init, redirect: 'manual' });
}
