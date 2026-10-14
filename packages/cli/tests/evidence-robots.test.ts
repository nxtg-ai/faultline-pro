// Validates: N-234 (evidence fetch honours robots.txt; emma-soul al:15b443bc1ccf7a4e, 2026-10-14)
/**
 * Before an evidence page (or any redirect hop) is requested, that site's
 * robots.txt is asked whether FaultlineEvidence may read it, per RFC 9309.
 * A disallowed page is never requested and reads {status: not_fetched,
 * reason: robots}. The answer is cached per origin for 24 hours.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchSourceEvidence, pickPassage, type EvidenceFetch } from '../evidence/passage.js';
import {
  clearRobotsCache,
  EVIDENCE_USER_AGENT,
  normalizePath,
  parseRobots,
  robotsVerdict,
  rulesAllow,
  ROBOTS_TTL_MS,
  ROBOTS_UNREACHABLE_TTL_MS,
} from '../evidence/robots.js';

const CLAIM_TEXT = 'The Eiffel Tower was completed in 1889.';
const PAGE = '<p>Construction finished in March 1889, and the Eiffel Tower was completed in time for the Fair.</p>';

const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

/** A site: robots.txt per origin, every other URL serves PAGE. Records every request. */
function site(robots: Record<string, Response | (() => Response) | Error>, pageFor: (url: string) => Response = () => html(PAGE)) {
  const requested: string[] = [];
  const f = vi.fn(async (url: string) => {
    requested.push(url);
    if (url.endsWith('/robots.txt')) {
      const r = robots[new URL(url).origin];
      if (r === undefined) return text('', 404);
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r() : r.clone();
    }
    return pageFor(url);
  }) as unknown as EvidenceFetch;
  return { f, requested, pages: () => requested.filter((u) => !u.endsWith('/robots.txt')) };
}

beforeEach(() => clearRobotsCache());

describe('parseRobots and rulesAllow (RFC 9309)', () => {
  const allows = (robots: string, path: string) => rulesAllow(parseRobots(robots), path);

  it('the group naming FaultlineEvidence applies instead of *, matched case-insensitively', () => {
    const robots = 'User-agent: *\nDisallow: /\n\nUser-agent: faultlineevidence\nDisallow: /private\n';
    expect(allows(robots, '/news/eiffel')).toBe(true);
    expect(allows(robots, '/private/x')).toBe(false);
  });

  it('with no group naming us, * applies; with neither, everything is allowed', () => {
    expect(allows('User-agent: *\nDisallow: /\n', '/a')).toBe(false);
    expect(allows('User-agent: Googlebot\nDisallow: /\n', '/a')).toBe(true);
    expect(allows('', '/a')).toBe(true);
  });

  it('several user-agent lines share one group, and a new user-agent after rules starts a new group', () => {
    const robots = 'User-agent: GPTBot\nUser-agent: FaultlineEvidence\nDisallow: /a\nUser-agent: *\nDisallow: /b\n';
    expect(allows(robots, '/a/1')).toBe(false);
    expect(allows(robots, '/b/1')).toBe(true);
  });

  it('the longest match wins and Allow wins a tie', () => {
    const robots = 'User-agent: *\nDisallow: /wiki/\nAllow: /wiki/Eiffel\nDisallow: /same\nAllow: /same\n';
    expect(allows(robots, '/wiki/Eiffel_Tower')).toBe(true);
    expect(allows(robots, '/wiki/Other')).toBe(false);
    expect(allows(robots, '/same')).toBe(true);
  });

  it('* matches any run of characters and $ anchors the end; the query string is part of the path', () => {
    const robots = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?q=\n';
    expect(allows(robots, '/files/a.pdf')).toBe(false);
    expect(allows(robots, '/files/a.pdf.html')).toBe(true);
    expect(allows(robots, '/search?q=eiffel')).toBe(false);
    expect(allows(robots, '/search')).toBe(true);
  });

  it('an empty Disallow allows everything; comments and unknown lines are ignored; /robots.txt is always allowed', () => {
    expect(allows('User-agent: *\nDisallow:\n', '/anything')).toBe(true);
    expect(allows('# hi\nUser-agent: * # all\nCrawl-delay: 5\nSitemap: https://x/s.xml\nDisallow: /x # no\n', '/x/1')).toBe(false);
    expect(allows('User-agent: *\nDisallow: /\n', '/robots.txt')).toBe(true);
  });

  it('regex characters in a path are literal', () => {
    expect(allows('User-agent: *\nDisallow: /a.b\n', '/aXb')).toBe(true);
    expect(allows('User-agent: *\nDisallow: /a.b\n', '/a.b/c')).toBe(false);
  });
});

describe('fetchSourceEvidence honours robots.txt', () => {
  const source = { title: 's', uri: 'https://pub.example/news/eiffel' };

  it('a disallowed page is never requested and reads not_fetched / robots', async () => {
    const s = site({ 'https://pub.example': text('User-agent: *\nDisallow: /news/\n') });
    const ev = await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: s.f });
    expect(ev).toEqual({ status: 'not_fetched', reason: 'robots', passage: null });
    expect(s.pages()).toEqual([]);
    expect(s.requested).toEqual(['https://pub.example/robots.txt']);
  });

  it('an allowed page is fetched and quoted', async () => {
    const s = site({ 'https://pub.example': text('User-agent: *\nDisallow: /private/\n') });
    const ev = await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: s.f });
    expect(ev.status).toBe('ok');
    expect(s.pages()).toEqual([source.uri]);
  });

  it('robots.txt is fetched with the named user agent and its contact URL, without following redirects silently', async () => {
    const s = site({});
    await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: s.f });
    const calls = (s.f as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect(calls.length).toBe(2);
    for (const [, init] of calls) {
      expect((init.headers as Record<string, string>)['user-agent']).toBe(EVIDENCE_USER_AGENT);
      expect(init.redirect).toBe('manual');
    }
    expect(EVIDENCE_USER_AGENT).toMatch(/^FaultlineEvidence\/\d+\.\d+ \(\+https:\/\/faultline\.nxtg\.ai\)$/);
  });

  it('a redirect hop to a site whose robots.txt disallows it is refused before that hop is requested', async () => {
    const s = site(
      { 'https://hop.example': text('User-agent: FaultlineEvidence\nDisallow: /\n') },
      (url) => (url === source.uri ? new Response(null, { status: 301, headers: { location: 'https://hop.example/eiffel' } }) : html(PAGE)),
    );
    const ev = await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: s.f });
    expect(ev).toEqual({ status: 'not_fetched', reason: 'robots', passage: null, finalUri: 'https://hop.example/eiffel' });
    expect(s.pages()).toEqual([source.uri]);
  });

  it('robots.txt answering 4xx means no rules: the page is fetched', async () => {
    const s = site({ 'https://pub.example': text('forbidden', 403) });
    expect((await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: s.f })).status).toBe('ok');
  });

  it('robots.txt answering 5xx or failing on the network means nothing there is fetched (fetch_failed)', async () => {
    const down = site({ 'https://pub.example': text('oops', 503) });
    expect((await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: down.f })).status).toBe('fetch_failed');
    expect(down.pages()).toEqual([]);
    clearRobotsCache();
    const offline = site({ 'https://pub.example': new TypeError('fetch failed') });
    expect((await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: offline.f })).status).toBe('fetch_failed');
    expect(offline.pages()).toEqual([]);
  });

  it('robots.txt at a refused address makes the page blocked', async () => {
    const blocked = Object.assign(new Error('Outbound URL blocked: private address'), { name: 'OutboundUrlBlockedError' });
    const s = site({ 'https://pub.example': blocked });
    expect((await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: s.f })).status).toBe('blocked');
    expect(s.pages()).toEqual([]);
  });

  it('robots.txt redirects are followed to the rules', async () => {
    const s = site({
      'https://pub.example': new Response(null, { status: 301, headers: { location: 'https://www.pub.example/robots.txt' } }),
      'https://www.pub.example': text('User-agent: *\nDisallow: /news/\n'),
    });
    expect(await fetchSourceEvidence(source, CLAIM_TEXT, { fetch: s.f })).toMatchObject({ status: 'not_fetched', reason: 'robots' });
  });
});

describe('robots.txt cache', () => {
  it('is asked once per origin and reused for 24 hours, then asked again', async () => {
    const s = site({ 'https://pub.example': () => text('User-agent: *\nDisallow: /private/\n') });
    const t0 = 1_000_000;
    expect(await robotsVerdict('https://pub.example/a', s.f, { now: t0 })).toBe('allow');
    expect(await robotsVerdict('https://pub.example/private/b', s.f, { now: t0 + 1000 })).toBe('disallow');
    expect(await robotsVerdict('https://pub.example/c', s.f, { now: t0 + ROBOTS_TTL_MS - 1 })).toBe('allow');
    expect(s.requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
    await robotsVerdict('https://pub.example/c', s.f, { now: t0 + ROBOTS_TTL_MS });
    expect(s.requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(2);
  });

  it('parallel requests to one origin share one robots.txt fetch; origins are separate', async () => {
    const s = site({});
    await Promise.all([
      robotsVerdict('https://a.example/1', s.f),
      robotsVerdict('https://a.example/2', s.f),
      robotsVerdict('https://b.example/1', s.f),
    ]);
    expect(s.requested.filter((u) => u.endsWith('/robots.txt')).sort()).toEqual(['https://a.example/robots.txt', 'https://b.example/robots.txt']);
  });

  it('an unreachable robots.txt is cached for 1 hour, not 24', async () => {
    let status = 503;
    const s = site({ 'https://pub.example': () => text('x', status) });
    const t0 = 5_000_000;
    expect(await robotsVerdict('https://pub.example/a', s.f, { now: t0 })).toBe('unreachable');
    status = 200;
    expect(await robotsVerdict('https://pub.example/a', s.f, { now: t0 + ROBOTS_UNREACHABLE_TTL_MS - 1 })).toBe('unreachable');
    expect(await robotsVerdict('https://pub.example/a', s.f, { now: t0 + ROBOTS_UNREACHABLE_TTL_MS })).toBe('allow');
  });
});

describe('Fable seat findings (2026-10-14), pinned', () => {
  const allows = (robots: string, path: string) => rulesAllow(parseRobots(robots), path);

  it('a hostile robots.txt cannot stall the server: star-heavy rules are matched without backtracking', () => {
    const t0 = performance.now();
    expect(allows(`User-agent: *\nDisallow: /${'a*'.repeat(12)}b\n`, `/${'a'.repeat(40)}`)).toBe(true);
    expect(allows('User-agent: *\nDisallow: /****x\n', `/${'y'.repeat(600)}`)).toBe(true);
    expect(allows('User-agent: *\nDisallow: /****x\n', `/${'y'.repeat(600)}x`)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('rules that cost more than the work budget disallow the page rather than run on', () => {
    const rules = parseRobots(`User-agent: *\n${Array.from({ length: 50 }, (_, i) => `Disallow: /*a*b*c*${i}`).join('\n')}\n`);
    expect(rulesAllow(rules, `/${'abc'.repeat(300)}`)).toBe(true);
    expect(rulesAllow(rules, `/${'abc'.repeat(300)}`, 1000)).toBe(false);
  });

  it('rule paths and URL paths compare in one percent-encoded form (RFC 9309 2.2.2)', () => {
    expect(normalizePath('/café')).toBe('/caf%C3%A9');
    expect(normalizePath('/%62%61%7a/%2f')).toBe('/baz/%2F');
    expect(allows('User-agent: *\nDisallow: /café\n', new URL('https://x.example/café').pathname)).toBe(false);
    expect(allows('User-agent: *\nDisallow: /%62%61%7A\n', '/baz/1')).toBe(false);
    expect(allows('User-agent: *\nDisallow: /a%3cb\n', '/a%3Cb')).toBe(false);
  });

  it('a robots.txt redirect onto the Google grounding host is never followed', async () => {
    const s = site({ 'https://pub.example': new Response(null, { status: 301, headers: { location: 'https://vertexaisearch.cloud.google.com/robots.txt' } }) });
    const ev = await fetchSourceEvidence({ title: 's', uri: 'https://pub.example/news/eiffel' }, CLAIM_TEXT, { fetch: s.f });
    expect(ev.status).toBe('fetch_failed');
    expect(s.requested.some((u) => u.includes('vertexaisearch'))).toBe(false);
    expect(s.pages()).toEqual([]);
  });

  it('a page redirect onto the Google grounding host is refused before it is requested', async () => {
    const s = site({}, (url) => (url === 'https://pub.example/a'
      ? new Response(null, { status: 302, headers: { location: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x' } })
      : html(PAGE)));
    const ev = await fetchSourceEvidence({ title: 's', uri: 'https://pub.example/a' }, CLAIM_TEXT, { fetch: s.f });
    expect(ev).toEqual({ status: 'not_fetched', reason: 'provider_terms', passage: null, finalUri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x' });
    expect(s.requested.some((u) => u.includes('vertexaisearch'))).toBe(false);
  });

  it('robots.txt time comes out of the source deadline, including a load another source started', async () => {
    const never: EvidenceFetch = (u, init) => new Promise((_r, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
    });
    const first = fetchSourceEvidence({ title: 'a', uri: 'https://slow.example/a' }, CLAIM_TEXT, { fetch: never, timeoutMs: 3000 });
    const t0 = performance.now();
    const second = await fetchSourceEvidence({ title: 'b', uri: 'https://slow.example/b' }, CLAIM_TEXT, { fetch: never, timeoutMs: 60 });
    expect(second.status).toBe('fetch_failed');
    expect(performance.now() - t0).toBeLessThan(1000);
    expect((await first).status).toBe('fetch_failed');
  });

  it('seat 2: a caller that stopped waiting leaves no unhandled rejection when robots.txt is at a refused address', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const blocked = Object.assign(new Error('Outbound URL blocked: private address'), { name: 'OutboundUrlBlockedError' });
      const f: EvidenceFetch = async () => { await new Promise((r) => setTimeout(r, 20)); throw blocked; };
      const gone = AbortSignal.abort();
      expect(await robotsVerdict('https://guarded.example/a', f, { signal: gone })).toBe('unreachable');
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toEqual([]);
      // A caller still waiting sees the refusal.
      await expect(robotsVerdict('https://guarded2.example/a', f)).rejects.toMatchObject({ name: 'OutboundUrlBlockedError' });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('seat 2: a caller with almost no time left does not cache "unreachable" for everyone else', async () => {
    const s = site({ 'https://healthy.example': () => text('User-agent: *\nDisallow: /private/\n') });
    // Answers in 20 ms and, like a real fetch, gives up when its signal aborts.
    const slowish: EvidenceFetch = (u, init) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(s.f(u, init)), 20);
      init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('timeout', 'TimeoutError')); }, { once: true });
    });
    expect(await robotsVerdict('https://healthy.example/a', slowish, { signal: AbortSignal.timeout(5) })).toBe('unreachable');
    await new Promise((r) => setTimeout(r, 100));
    expect(await robotsVerdict('https://healthy.example/a', slowish)).toBe('allow');
    expect(s.requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('seat 3: a page redirect loop stops after 5 redirects (6 requests) as fetch_failed', async () => {
    const s = site({}, (url) => new Response(null, { status: 302, headers: { location: url.endsWith('/a') ? 'https://loop.example/b' : 'https://loop.example/a' } }));
    const ev = await fetchSourceEvidence({ title: 'l', uri: 'https://loop.example/a' }, CLAIM_TEXT, { fetch: s.f });
    expect(ev.status).toBe('fetch_failed');
    expect(s.pages()).toHaveLength(6);
  });

  it('seat 3: a robots.txt redirect loop stops after 5 redirects (6 requests) and counts as no rules', async () => {
    const requested: string[] = [];
    const f = vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith('/robots.txt')) return new Response(null, { status: 301, headers: { location: 'https://rloop.example/robots.txt' } });
      return html(PAGE);
    }) as unknown as EvidenceFetch;
    expect(await robotsVerdict('https://rloop.example/a', f)).toBe('allow');
    expect(requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(6);
  });

  it('the cut never separates a letter from its accent', () => {
    const lead = 'The Eiffel Tower was completed in 1889 over Paris ';
    for (const pad of ['', 'x']) {
      const q = pickPassage(`${lead}${pad}${'e\u0301'.repeat(200)}.`, CLAIM_TEXT)!;
      expect(Array.from(q).length).toBeLessThanOrEqual(300);
      expect(q).toMatch(/e\u0301…$/);
    }
  });

  it('the 300-character cap counts code points and never splits a character', () => {
    const long = `Eiffel Tower completed 1889 ${'and more 🗼 words follow 🗼 here '.repeat(30)}.`;
    const p = pickPassage(long, CLAIM_TEXT)!;
    expect(Array.from(p).length).toBeLessThanOrEqual(300);
    expect(p.endsWith('…')).toBe(true);
    expect(p).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // No space near the cut, so it falls inside a run of emoji: once at an odd and once at an even UTF-16 offset.
    for (const lead of ['The Eiffel Tower was completed in 1889 over Paris ', 'The Eiffel Tower was completed in 1889 over Pariss ']) {
      const q = pickPassage(`${lead}${'🗼'.repeat(200)}.`, CLAIM_TEXT)!;
      expect(Array.from(q).length).toBeLessThanOrEqual(300);
      expect(q).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });
});
