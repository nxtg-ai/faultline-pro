import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getRateLimiter,
  resetRateLimiter,
  setCustomLimit,
} from '../src/store/ratelimit.js';
import {
  getRateLimitAlertStore,
  resetRateLimitAlertStore,
  checkAndAlert,
  ALERT_THRESHOLD_PCT,
} from '../src/store/rate-alerts.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetRateLimiter();
  resetRateLimitAlertStore();
  resetKeyStore();
  process.env.FAULTLINE_API_KEY = 'admin-secret';
  delete process.env.FAULTLINE_ALERT_WEBHOOK;
}

// ── RateLimiter.getAllStats ────────────────────────────────────────────────────

describe('RateLimiter.getAllStats', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('returns empty array when no keys seen', () => {
    expect(getRateLimiter().getAllStats()).toHaveLength(0);
  });

  it('returns stats for a key after increment', () => {
    getRateLimiter().setTierCache('key-a', 'free');
    setCustomLimit('key-a', 5);
    getRateLimiter().increment('key-a');
    getRateLimiter().increment('key-a');
    const stats = getRateLimiter().getAllStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]?.keyId).toBe('key-a');
    expect(stats[0]?.used).toBe(2);
    expect(stats[0]?.limit).toBe(5);
    expect(stats[0]?.usedPct).toBe(40);
    expect(stats[0]?.remaining).toBe(3);
  });

  it('records throttle count', () => {
    getRateLimiter().setTierCache('key-b', 'free');
    getRateLimiter().recordThrottle('key-b');
    getRateLimiter().recordThrottle('key-b');
    const stats = getRateLimiter().getAllStats();
    const entry = stats.find(s => s.keyId === 'key-b');
    expect(entry?.throttleCount).toBe(2);
  });

  it('sorts by usedPct descending', () => {
    getRateLimiter().setTierCache('low', 'free');
    getRateLimiter().setTierCache('high', 'free');
    setCustomLimit('low', 10);
    setCustomLimit('high', 10);
    getRateLimiter().increment('low');          // 10%
    for (let i = 0; i < 8; i++) getRateLimiter().increment('high'); // 80%
    const stats = getRateLimiter().getAllStats();
    expect(stats[0]?.keyId).toBe('high');
    expect(stats[1]?.keyId).toBe('low');
  });
});

// ── RateLimitAlertStore ───────────────────────────────────────────────────────

describe('RateLimitAlertStore', () => {
  beforeEach(() => {
    // Freeze Date mid-minute: 'checkAndAlert does not double-fire in same window'
    // calls checkAndAlert twice with one await each. If real time crosses a minute
    // boundary between the two calls, windowKey() returns a new value, the
    // deduplication check in shouldAlert() fails, and a second alert fires.
    // { toFake: ['Date'] } — leave setTimeout/setImmediate real (no server here,
    // but some inline vi.useFakeTimers() tests manage their own timer lifecycle).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T12:30:00.000Z'));
    setup();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ALERT_THRESHOLD_PCT is 80', () => {
    expect(ALERT_THRESHOLD_PCT).toBe(80);
  });

  it('shouldAlert returns false below threshold', () => {
    expect(getRateLimitAlertStore().shouldAlert('k', 7, 10)).toBe(false);
  });

  it('shouldAlert returns true at threshold', () => {
    expect(getRateLimitAlertStore().shouldAlert('k', 8, 10)).toBe(true);
  });

  it('shouldAlert returns true above threshold', () => {
    expect(getRateLimitAlertStore().shouldAlert('k', 10, 10)).toBe(true);
  });

  it('shouldAlert deduplicates within same window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T10:05:00Z'));
    await getRateLimitAlertStore().fire('k', 9, 10);
    // Same window — should not re-fire
    expect(getRateLimitAlertStore().shouldAlert('k', 9, 10)).toBe(false);
    vi.useRealTimers();
  });

  it('shouldAlert allows re-firing in a new window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T10:05:00Z'));
    await getRateLimitAlertStore().fire('k', 9, 10);
    // Advance to next minute
    vi.setSystemTime(new Date('2026-03-20T10:06:00Z'));
    expect(getRateLimitAlertStore().shouldAlert('k', 9, 10)).toBe(true);
    vi.useRealTimers();
  });

  it('fire stores alert in history', async () => {
    await getRateLimitAlertStore().fire('key-x', 9, 10);
    const alerts = getRateLimitAlertStore().getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.keyId).toBe('key-x');
    expect(alerts[0]?.used).toBe(9);
    expect(alerts[0]?.limit).toBe(10);
    expect(alerts[0]?.pct).toBe(90);
  });

  it('fire with no webhook → deliveryNote is console-only', async () => {
    await getRateLimitAlertStore().fire('key-y', 8, 10);
    expect(getRateLimitAlertStore().getAlerts()[0]?.deliveryNote).toBe('console-only');
  });

  it('checkAndAlert is a no-op below threshold', async () => {
    await checkAndAlert('k', 5, 10);
    expect(getRateLimitAlertStore().getAlerts()).toHaveLength(0);
  });

  it('checkAndAlert fires alert at threshold', async () => {
    await checkAndAlert('k', 8, 10);
    expect(getRateLimitAlertStore().getAlerts()).toHaveLength(1);
  });

  it('checkAndAlert does not double-fire in same window', async () => {
    await checkAndAlert('k', 8, 10);
    await checkAndAlert('k', 9, 10);
    expect(getRateLimitAlertStore().getAlerts()).toHaveLength(1);
  });

  it('getAlerts returns newest first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T10:05:00Z'));
    await getRateLimitAlertStore().fire('k1', 9, 10);
    vi.setSystemTime(new Date('2026-03-20T10:06:00Z'));
    await getRateLimitAlertStore().fire('k2', 9, 10);
    const alerts = getRateLimitAlertStore().getAlerts();
    expect(alerts[0]?.keyId).toBe('k2');
    expect(alerts[1]?.keyId).toBe('k1');
    vi.useRealTimers();
  });
});

// ── HTTP: GET /rate-limits ────────────────────────────────────────────────────

describe('GET /rate-limits', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with text/html (public — no auth)', async () => {
    const res = await server.inject({ method: 'GET', url: '/rate-limits' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML contains "Rate Limit Dashboard"', async () => {
    const res = await server.inject({ method: 'GET', url: '/rate-limits' });
    expect(res.body).toContain('Rate Limit Dashboard');
  });

  it('HTML references /rate-limits.json', async () => {
    const res = await server.inject({ method: 'GET', url: '/rate-limits' });
    expect(res.body).toContain('/rate-limits.json');
  });

  it('HTML includes auto-refresh countdown', async () => {
    const res = await server.inject({ method: 'GET', url: '/rate-limits' });
    expect(res.body).toContain('setInterval');
    expect(res.body).toContain('countdown');
  });

  it('HTML shows alert threshold', async () => {
    const res = await server.inject({ method: 'GET', url: '/rate-limits' });
    expect(res.body).toContain(String(ALERT_THRESHOLD_PCT) + '%');
  });
});

// ── HTTP: GET /rate-limits.json ───────────────────────────────────────────────

describe('GET /rate-limits.json', () => {
  let server: FastifyInstance;
  beforeEach(() => {
    // Freeze time mid-minute to prevent window resets at minute boundaries.
    // The rate limiter's windowKey uses toISOString().slice(0,16) (YYYY-MM-DDTHH:mm).
    // If a test runs across a minute boundary, increments land in minute N but
    // getAllStats() reads in minute N+1 — resetting the counter to 0. Fix: pin time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:30:00.000Z'));
    setup();
    server = buildServer();
  });
  afterEach(async () => {
    await server.close();
    vi.useRealTimers();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('returns 401 without API key', async () => {
    const res = await server.inject({ method: 'GET', url: '/rate-limits.json' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with valid key', async () => {
    const res = await server.inject({
      method: 'GET', url: '/rate-limits.json',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('payload has required top-level fields', async () => {
    const res = await server.inject({
      method: 'GET', url: '/rate-limits.json',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('generatedAt');
    expect(body).toHaveProperty('summary');
    expect(body).toHaveProperty('keys');
    expect(body).toHaveProperty('alerts');
  });

  it('summary has totalKeys, throttledKeys, criticalKeys, warningKeys', async () => {
    const res = await server.inject({
      method: 'GET', url: '/rate-limits.json',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const { summary } = JSON.parse(res.body);
    expect(typeof summary.totalKeys).toBe('number');
    expect(typeof summary.throttledKeys).toBe('number');
    expect(typeof summary.criticalKeys).toBe('number');
    expect(typeof summary.warningKeys).toBe('number');
  });

  it('keys array includes a key after increment', async () => {
    getRateLimiter().setTierCache('test-key', 'free');
    setCustomLimit('test-key', 10);
    getRateLimiter().increment('test-key');
    const res = await server.inject({
      method: 'GET', url: '/rate-limits.json',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const body = JSON.parse(res.body);
    const entry = body.keys.find((k: { keyId: string }) => k.keyId === 'test-key');
    expect(entry).toBeDefined();
    expect(entry.used).toBe(1);
    expect(entry.limit).toBe(10);
    expect(entry.usedPct).toBe(10);
  });

  it('summary.warningKeys counts keys >= 80% used', async () => {
    getRateLimiter().setTierCache('warn-key', 'free');
    setCustomLimit('warn-key', 10);
    for (let i = 0; i < 8; i++) getRateLimiter().increment('warn-key');
    const res = await server.inject({
      method: 'GET', url: '/rate-limits.json',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(JSON.parse(res.body).summary.warningKeys).toBe(1);
  });

  it('summary.throttledKeys counts keys with throttleCount > 0', async () => {
    getRateLimiter().setTierCache('t-key', 'free');
    getRateLimiter().recordThrottle('t-key');
    const res = await server.inject({
      method: 'GET', url: '/rate-limits.json',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(JSON.parse(res.body).summary.throttledKeys).toBe(1);
  });

  it('alerts array shows fired alerts', async () => {
    await checkAndAlert('alerted-key', 9, 10);
    const res = await server.inject({
      method: 'GET', url: '/rate-limits.json',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const body = JSON.parse(res.body);
    expect(body.alerts.length).toBe(1);
    expect(body.alerts[0].keyId).toBe('alerted-key');
  });
});
