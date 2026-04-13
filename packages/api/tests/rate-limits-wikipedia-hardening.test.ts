/**
 * Rate Limits + Wikipedia Hardening Tests (N-153) — RL1–RL8, WP1–WP3
 *
 * Validates: N-39 (Production API Hardening), N-27 (Provider Plugin System)
 *
 * Covers uncovered branches in two modules:
 *   RL1–RL4 : routes/rate-limits.ts — statusBadge() four threshold branches
 *              (lines 23-26): pct>=100 THROTTLED, pct>=ALERT_THRESHOLD WARNING,
 *              pct>=50 ACTIVE, pct<50 OK
 *   RL5–RL8 : routes/rate-limits.ts — meterBar() four CSS-class branches
 *              (line 30): meter-critical, meter-warning, meter-moderate, meter-ok
 *   WP1–WP3 : providers/wikipedia.ts — mixed branch (lines 56-61, 0.3<=ratio<0.6),
 *              unverified-with-results branch (lines 62-68, ratio<0.3),
 *              no-title fallback (line 48 ?? 'Wikipedia')
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getRateLimiter,
  resetRateLimiter,
  setCustomLimit,
} from '../src/store/ratelimit.js';
import { resetRateLimitAlertStore, ALERT_THRESHOLD_PCT } from '../src/store/rate-alerts.js';
import { resetKeyStore } from '../src/store/keys.js';
import type { FastifyInstance } from 'fastify';

// ===========================================================================
// RL1–RL4 — statusBadge() threshold branches (lines 23-26)
// ===========================================================================

describe('GET /rate-limits HTML — statusBadge() branches (lines 23-26)', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    // Freeze time mid-minute: seedKey() calls increment() then server.inject()
    // reads getAllStats(). If a minute boundary falls between the two calls, the
    // rate limiter resets the counter to 0 and the badge threshold test fails.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:30:00.000Z'));
    resetRateLimiter();
    resetRateLimitAlertStore();
    resetKeyStore();
    process.env.FAULTLINE_API_KEY = 'admin-secret';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    vi.useRealTimers();
    delete process.env.FAULTLINE_API_KEY;
  });

  function seedKey(keyId: string, limit: number, increments: number) {
    getRateLimiter().setTierCache(keyId, 'free');
    setCustomLimit(keyId, limit);
    for (let i = 0; i < increments; i++) {
      getRateLimiter().increment(keyId);
    }
  }

  it('RL1: pct >= 100 → badge-critical "THROTTLED" (line 23)', async () => {
    seedKey('k-critical', 1, 1); // limit=1, used=1 → 100%

    const res = await server.inject({
      method: 'GET',
      url: '/rate-limits',
      headers: { 'x-api-key': 'admin-secret' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('badge-critical');
    expect(res.body).toContain('THROTTLED');
  });

  it('RL2: pct >= ALERT_THRESHOLD (80) → badge-warning "WARNING" (line 24)', async () => {
    seedKey('k-warning', 5, 4); // limit=5, used=4 → 80% = ALERT_THRESHOLD

    const res = await server.inject({
      method: 'GET',
      url: '/rate-limits',
      headers: { 'x-api-key': 'admin-secret' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('badge-warning');
    expect(res.body).toContain('WARNING');
  });

  it('RL3: pct >= 50 (below threshold) → badge-moderate "ACTIVE" (line 25)', async () => {
    // 60% usage — above 50, below ALERT_THRESHOLD_PCT
    seedKey('k-moderate', 10, 6); // limit=10, used=6 → 60%

    const res = await server.inject({
      method: 'GET',
      url: '/rate-limits',
      headers: { 'x-api-key': 'admin-secret' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('badge-moderate');
    expect(res.body).toContain('ACTIVE');
  });

  it('RL4: pct < 50 → badge-ok "OK" (line 26)', async () => {
    seedKey('k-ok', 100, 10); // limit=100, used=10 → 10%

    const res = await server.inject({
      method: 'GET',
      url: '/rate-limits',
      headers: { 'x-api-key': 'admin-secret' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('badge-ok');
    expect(res.body).toContain('>OK<');
  });
});

// ===========================================================================
// RL5–RL8 — meterBar() CSS class branches (line 30)
// ===========================================================================

describe('GET /rate-limits HTML — meterBar() CSS class branches (line 30)', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    // Freeze time mid-minute: seedKey() calls increment() then server.inject()
    // reads getAllStats(). If a minute boundary falls between the two calls, the
    // rate limiter resets the counter to 0 and the meter class assertion fails.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:30:00.000Z'));
    resetRateLimiter();
    resetRateLimitAlertStore();
    resetKeyStore();
    process.env.FAULTLINE_API_KEY = 'admin-secret';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    vi.useRealTimers();
    delete process.env.FAULTLINE_API_KEY;
  });

  function seedKey(keyId: string, limit: number, increments: number) {
    getRateLimiter().setTierCache(keyId, 'free');
    setCustomLimit(keyId, limit);
    for (let i = 0; i < increments; i++) {
      getRateLimiter().increment(keyId);
    }
  }

  it('RL5: pct >= 100 → meter-critical class (line 30 first ternary branch)', async () => {
    seedKey('k-c', 1, 1);
    const res = await server.inject({
      method: 'GET', url: '/rate-limits',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.body).toContain('meter-critical');
  });

  it('RL6: pct >= ALERT_THRESHOLD → meter-warning class (line 30 second ternary branch)', async () => {
    seedKey('k-w', 5, 4);
    const res = await server.inject({
      method: 'GET', url: '/rate-limits',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.body).toContain('meter-warning');
  });

  it('RL7: pct >= 50 → meter-moderate class (line 30 third ternary branch)', async () => {
    seedKey('k-m', 10, 6);
    const res = await server.inject({
      method: 'GET', url: '/rate-limits',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.body).toContain('meter-moderate');
  });

  it('RL8: pct < 50 → meter-ok class (line 30 default branch)', async () => {
    seedKey('k-o', 100, 10);
    const res = await server.inject({
      method: 'GET', url: '/rate-limits',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.body).toContain('meter-ok');
  });
});

// ===========================================================================
// WP1–WP3 — providers/wikipedia.ts uncovered branches (lines 48, 56-68)
// ===========================================================================

describe('wikipediaProvider.verify() — matchRatio branches (lines 56-68)', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function wikiResponse(snippets: string[], title = 'Test Article') {
    return Promise.resolve({
      ok: true,
      json: async () => ({
        query: {
          search: snippets.map(snippet => ({ snippet, title })),
        },
      }),
    });
  }

  it('WP1: matchRatio >= 0.3 and < 0.6 → status "mixed" (lines 56-61)', async () => {
    // claim has 4 words >4 chars: abcde fghij klmno pqrst
    // snippets contain 2 of 4 → matchRatio = 0.5 → mixed
    mockFetch.mockReturnValue(wikiResponse(['abcde fghij and unrelated text']));
    const { wikipediaProvider } = await import('../src/providers/wikipedia.js');

    const result = await wikipediaProvider.verify('abcde fghij klmno pqrst');
    expect(result.status).toBe('mixed');
    expect(result.explanation).toContain('partially addresses');
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('WP2: matchRatio < 0.3, results exist → status "unverified" (lines 62-68)', async () => {
    // claim has 4 words >4 chars: abcde fghij klmno pqrst
    // snippets contain only 1 of 4 → matchRatio = 0.25 → unverified
    mockFetch.mockReturnValue(wikiResponse(['abcde unrelated snippet text here']));
    const { wikipediaProvider } = await import('../src/providers/wikipedia.js');

    const result = await wikipediaProvider.verify('abcde fghij klmno pqrst');
    expect(result.status).toBe('unverified');
    expect(result.explanation).toContain('no strong match');
    expect(result.confidence).toBe(0.1);
  });

  it('WP3: result with no title falls back to "Wikipedia" (line 48 ?? branch)', async () => {
    // Return a search result with no title field → topTitle = 'Wikipedia'
    mockFetch.mockReturnValue(
      Promise.resolve({
        ok: true,
        json: async () => ({
          query: {
            // title is undefined — hits the ?? 'Wikipedia' fallback
            search: [{ snippet: 'abcde fghij klmno pqrst vwxyz extra words', title: undefined }],
          },
        }),
      }),
    );
    const { wikipediaProvider } = await import('../src/providers/wikipedia.js');

    const result = await wikipediaProvider.verify('abcde fghij klmno pqrst');
    // High match → supported; explanation references fallback title
    expect(['supported', 'mixed']).toContain(result.status);
    expect(result.explanation).toContain('Wikipedia');
  });
});
