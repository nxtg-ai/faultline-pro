/**
 * robots.txt for evidence fetches (emma-soul al:15b443bc1ccf7a4e, 2026-10-14).
 *
 * OpenAI's terms clear our use of a search result's URL; they say nothing about
 * the publisher's page, which each site governs. So every page fetch first asks
 * that site's robots.txt whether `FaultlineEvidence` may read the path, per RFC
 * 9309 (https://www.rfc-editor.org/rfc/rfc9309):
 * - the group naming our product token applies, else the `*` group, else none;
 * - the longest matching rule wins, and Allow wins a tie; `*` and `$` are honoured;
 * - rule paths and the URL path are compared in one percent-encoded form (2.2.2);
 * - robots.txt answering 4xx means no rules (2.3.1.3);
 * - robots.txt unreachable (5xx, network error, timeout) means disallow all
 *   (2.3.1.4); the caller reports that as fetch_failed, since the site, not
 *   its rules, is what stopped the fetch.
 *
 * Rules are matched without regular expressions, in time linear in the path
 * for each pattern character, and every verdict has a fixed work budget: a
 * robots.txt too costly to evaluate is treated as disallowing the page. A
 * hostile robots.txt can therefore never stall the server (Fable seat HIGH,
 * 2026-10-14: a regex form took 19 to 37 s on a 12-star rule).
 *
 * The answer is cached per origin for 24 hours (RFC 9309 2.4). An unreachable
 * robots.txt is cached for 1 hour, so a brief outage does not shut a site out
 * for a day. The cache is bounded by the total size of the rules it holds.
 * Loads are shared per origin; a load a caller stopped waiting for runs on
 * for at most ROBOTS_TIMEOUT_MS, so loads in flight are bounded by time, not
 * count (at most one per origin a running scan cites, times the scan's
 * verify concurrency).
 */
import type { EvidenceFetch } from './passage.js';
import { isGroundingRedirect } from './grounding.js';

export const EVIDENCE_PRODUCT_TOKEN = 'FaultlineEvidence';
export const EVIDENCE_USER_AGENT = `${EVIDENCE_PRODUCT_TOKEN}/1.0 (+https://faultline.nxtg.ai)`;

export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
export const ROBOTS_UNREACHABLE_TTL_MS = 60 * 60 * 1000;
const ROBOTS_MAX_BYTES = 500 * 1024; // RFC 9309 2.5: parse at least the first 500 KiB
const ROBOTS_MAX_REDIRECTS = 5; // RFC 9309 2.3.1.2: follow at least five
const ROBOTS_TIMEOUT_MS = 4000;
/** Character comparisons one verdict may spend before it gives up and disallows. */
export const ROBOTS_MATCH_BUDGET = 2_000_000;
/** Total rule characters the cache may hold across all origins. */
const CACHE_MAX_CHARS = 16_000_000;

interface Rule { allow: boolean; path: string }

/** null = disallow everything (robots.txt unreachable). */
type Rules = Rule[] | null;

interface Entry { rules: Promise<Rules>; expires: number; chars: number }

const cache = new Map<string, Entry>();
let cachedChars = 0;

/** Test seam. */
export function clearRobotsCache(): void {
  cache.clear();
  cachedChars = 0;
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * One comparable form for a rule path or a URL path (RFC 9309 2.2.2): non-ASCII
 * characters percent-encoded as UTF-8, %XX of an unreserved character decoded,
 * every other %XX in upper case.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/[^\x00-\x7F]/gu, (ch) => encodeURIComponent(ch))
    .replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => {
      const ch = String.fromCharCode(parseInt(hex, 16));
      return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
    });
}

/** The rules from a robots.txt body that apply to `token` (case-insensitive). */
export function parseRobots(text: string, token = EVIDENCE_PRODUCT_TOKEN): Rule[] {
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  let open: { agents: string[]; rules: Rule[] } | null = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!open || open.rules.length > 0) { open = { agents: [], rules: [] }; groups.push(open); }
      open.agents.push(value.split('/')[0].trim().toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && open) {
      // An empty value matches nothing, but still closes the group's user-agent list.
      if (value === '') { if (open.rules.length === 0) open.rules.push({ allow: true, path: '' }); continue; }
      open.rules.push({ allow: key === 'allow', path: normalizePath(value).replace(/\*+/g, '*') });
    }
  }
  const named = groups.filter((g) => g.agents.includes(token.toLowerCase()));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

/**
 * Whether `pattern` (with `*` and a trailing `$`) matches the start of `path`.
 * Tracks the set of path positions reachable so far, never backtracking
 * (the method of google/robotstxt). Each step's work is charged to `budget`.
 */
function matches(path: string, pattern: string, budget: { left: number }): boolean {
  let positions = [0];
  for (let j = 0; j < pattern.length; j++) {
    const ch = pattern[j];
    if (ch === '$' && j === pattern.length - 1) return positions[positions.length - 1] === path.length;
    if (ch === '*') {
      const from = positions[0];
      budget.left -= path.length - from + 1;
      positions = [];
      for (let p = from; p <= path.length; p++) positions.push(p);
    } else {
      budget.left -= positions.length;
      const next: number[] = [];
      for (const p of positions) if (p < path.length && path[p] === ch) next.push(p + 1);
      if (next.length === 0) return false;
      positions = next;
    }
    if (budget.left < 0) return false;
  }
  return true;
}

/**
 * Whether `rules` let the crawler read `pathAndQuery`; false when the rules
 * cost more than `budgetChars` comparisons to evaluate.
 */
export function rulesAllow(rules: Rules, pathAndQuery: string, budgetChars = ROBOTS_MATCH_BUDGET): boolean {
  if (rules === null) return false;
  const path = normalizePath(pathAndQuery);
  if (path === '/robots.txt') return true;
  const budget = { left: budgetChars };
  let best: Rule | undefined;
  for (const r of rules) {
    if (r.path === '') continue;
    // A literal prefix before the first `*` rules most patterns out at once.
    const star = r.path.indexOf('*');
    const prefix = (star < 0 ? r.path : r.path.slice(0, star)).replace(/\$$/, '');
    budget.left -= prefix.length;
    if (budget.left < 0) return false;
    if (!path.startsWith(prefix)) continue;
    const hit = matches(path, r.path, budget);
    if (budget.left < 0) return false;
    if (!hit) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r;
  }
  return best ? best.allow : true;
}

async function readText(res: Response): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, ROBOTS_MAX_BYTES);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= ROBOTS_MAX_BYTES) { void reader.cancel().catch(() => undefined); break; }
  }
  const bytes = new Uint8Array(Math.min(total, ROBOTS_MAX_BYTES));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, bytes.length - at);
    bytes.set(c.subarray(0, take), at);
    at += take;
    if (at >= bytes.length) break;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

const isBlocked = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'OutboundUrlBlockedError' || /blocked|not allowed|private address/i.test(err.message));

/** Thrown when robots.txt itself sits at a refused address; the page is refused too. */
export class RobotsBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'OutboundUrlBlockedError'; }
}

const UNREACHABLE = { rules: null, ttl: ROBOTS_UNREACHABLE_TTL_MS } as const;

async function loadRules(origin: string, fetch: EvidenceFetch, timeoutMs: number): Promise<{ rules: Rules; ttl: number }> {
  let url = `${origin}/robots.txt`;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      // Never request anything on Google's grounding host, robots.txt included.
      if (isGroundingRedirect(url) || !/^https?:\/\//i.test(url)) return UNREACHABLE;
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': EVIDENCE_USER_AGENT, accept: 'text/plain' },
        signal,
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        void res.body?.cancel().catch(() => undefined); // never wait on the peer to drain
        if (hop >= ROBOTS_MAX_REDIRECTS) return { rules: [], ttl: ROBOTS_TTL_MS }; // RFC 9309 2.3.1.2: treat as unavailable
        url = new URL(location, url).toString();
        continue;
      }
      if (res.status >= 200 && res.status < 300) return { rules: parseRobots(await readText(res)), ttl: ROBOTS_TTL_MS };
      void res.body?.cancel().catch(() => undefined);
      if (res.status >= 400 && res.status < 500) return { rules: [], ttl: ROBOTS_TTL_MS };
      return UNREACHABLE;
    }
  } catch (err) {
    if (isBlocked(err)) throw new RobotsBlockedError(err instanceof Error ? err.message : String(err));
    return UNREACHABLE;
  }
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | 'aborted'> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

function evictUntilFits(): void {
  while (cachedChars > CACHE_MAX_CHARS && cache.size > 0) {
    const [origin, oldest] = cache.entries().next().value as [string, Entry];
    cache.delete(origin);
    cachedChars -= oldest.chars;
  }
}

export type RobotsVerdict = 'allow' | 'disallow' | 'unreachable';

/**
 * Whether robots.txt on the URL's origin lets FaultlineEvidence read it:
 * allow, disallow, or unreachable (robots.txt could not be read, or not before
 * `signal` aborted, so nothing on that origin is fetched). Throws an
 * OutboundUrlBlockedError-named error when robots.txt is at a refused address.
 */
export async function robotsVerdict(
  rawUrl: string,
  fetch: EvidenceFetch,
  opts: { signal?: AbortSignal; now?: number } = {},
): Promise<RobotsVerdict> {
  const now = opts.now ?? Date.now();
  const url = new URL(rawUrl);
  const origin = url.origin;
  let entry = cache.get(origin);
  if (!entry || entry.expires <= now) {
    if (entry) { cache.delete(origin); cachedChars -= entry.chars; }
    // The shared load always gets its full time: a caller with little time left
    // stops waiting through its own signal below, and must not cut the load
    // short and cache "unreachable" for every other caller (Fable seat 2 HIGH).
    const loaded = loadRules(origin, fetch, ROBOTS_TIMEOUT_MS);
    const fresh: Entry = { rules: loaded.then((l) => l.rules), expires: now + ROBOTS_TTL_MS, chars: 0 };
    // Marked handled: a caller that stopped waiting must not leave a rejection
    // unhandled, which would end the process (Fable seat 2 HIGH). Awaiters still see it.
    fresh.rules.catch(() => undefined);
    entry = fresh;
    cache.set(origin, fresh);
    loaded.then(
      (l) => {
        fresh.expires = now + l.ttl;
        if (cache.get(origin) !== fresh) return;
        fresh.chars = (l.rules ?? []).reduce((n, r) => n + r.path.length + 8, 64);
        cachedChars += fresh.chars;
        evictUntilFits();
      },
      () => { if (cache.get(origin) === fresh) cache.delete(origin); },
    );
  }
  // A robots.txt load started by another source may outlast this source's deadline.
  const rules = await untilAborted(entry.rules, opts.signal);
  if (rules === 'aborted' || rules === null) return 'unreachable';
  return rulesAllow(rules, `${url.pathname}${url.search}`) ? 'allow' : 'disallow';
}
