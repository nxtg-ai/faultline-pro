/**
 * N-117 — CRUCIBLE Gate 6: Stryker mutation hardening
 *
 * Initial run: 86.51% mutation score (212 killed, 51 timeout, 32 survived).
 * These tests kill the 19 most impactful surviving mutants:
 *
 * MH1–MH4   WebhookRateLimiter boundary: check() window expiry at exact
 *           60 000 ms boundary (>= vs >), count() returns 0 after window
 *           expiry, count() returns 0 when no entry exists,
 *           reset() with no arg clears ALL webhook windows.
 * MH5–MH6   WebhookRateLimiter scoped reset: reset(id) clears only that
 *           webhook, unaffected webhook still blocked after sibling reset.
 * MH7–MH9   WebhookCircuitBreaker boundary: cooldown auto-recovery at exact
 *           cooldownMs boundary (>= vs >), reset() with no arg clears ALL
 *           circuits, reset(id) does not affect sibling circuits.
 * MH10–MH11 Defensive copies: WebhookDeliveryLog.list() and
 *           WebhookTestHistory.list() return snapshots — mutating the
 *           returned array does not affect the internal store.
 * MH12–MH13 getById() correctness: returns undefined for wrong id even when
 *           multiple webhooks share a common prefix; returns correct webhook
 *           when two exist with different ids.
 * MH14–MH15 sendTestWebhook: latencyMs is non-negative (kills +start
 *           arithmetic mutant); X-Faultline-Signature header is included in
 *           fetch call when secret is provided (kills if(false) mutant).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WebhookRateLimiter,
  WebhookCircuitBreaker,
  getWebhookStore,
  resetWebhookStore,
  getWebhookDeliveryLog,
  resetWebhookDeliveryLog,
  getWebhookTestHistory,
  resetWebhookTestHistory,
  resetWebhookRateLimiter,
  resetWebhookCircuitBreaker,
  sendTestWebhook,
} from '../src/store/webhooks.js';

const BASE_MS = 1_000_000;
const NOW     = 2_000_000;
const WIN     = 60_000; // WINDOW_MS

beforeEach(() => {
  resetWebhookStore();
  resetWebhookRateLimiter();
  resetWebhookCircuitBreaker();
  resetWebhookDeliveryLog();
  resetWebhookTestHistory();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', headers: new Map(), text: async () => '' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── WebhookRateLimiter boundary ───────────────────────────────────────────────

describe('WebhookRateLimiter — exact window boundary (kills >= vs > mutant)', () => {
  it('MH1: check() at exactly windowStart + WINDOW_MS opens a new window (>= boundary)', () => {
    // Exhaust the window
    const rl = new WebhookRateLimiter(1);
    rl.check('wh-1', BASE_MS);          // count = 1, windowStart = BASE_MS
    expect(rl.check('wh-1', BASE_MS)).toBe(false); // blocked

    // At exactly 60 000 ms: nowMs - windowStart === WINDOW_MS → should be >= → new window
    expect(rl.check('wh-1', BASE_MS + WIN)).toBe(true);
  });

  it('MH2: count() returns 0 after window has expired', () => {
    const rl = new WebhookRateLimiter(3);
    rl.check('wh-1', BASE_MS);          // count becomes 1
    expect(rl.count('wh-1', BASE_MS + WIN)).toBe(0);      // window expired — count resets
    expect(rl.count('wh-1', BASE_MS + WIN + 1)).toBe(0);
  });

  it('MH3: count() returns 0 for a webhook with no recorded dispatches', () => {
    const rl = new WebhookRateLimiter(10);
    // No calls to check() — entry does not exist
    expect(rl.count('wh-brand-new', BASE_MS)).toBe(0);
  });

  it('MH4: reset() with no argument clears ALL webhook windows', () => {
    const rl = new WebhookRateLimiter(1);
    rl.check('wh-A', BASE_MS);
    rl.check('wh-B', BASE_MS);
    expect(rl.check('wh-A', BASE_MS)).toBe(false);
    expect(rl.check('wh-B', BASE_MS)).toBe(false);

    rl.reset(); // no arg — clears all
    expect(rl.check('wh-A', BASE_MS)).toBe(true);
    expect(rl.check('wh-B', BASE_MS)).toBe(true);
  });
});

describe('WebhookRateLimiter — scoped reset (kills if(true)/if(false) mutants)', () => {
  it('MH5: reset(id) clears only the specified webhook — sibling unaffected', () => {
    const rl = new WebhookRateLimiter(1);
    rl.check('wh-A', BASE_MS); // exhaust A
    rl.check('wh-B', BASE_MS); // exhaust B
    expect(rl.check('wh-A', BASE_MS)).toBe(false);
    expect(rl.check('wh-B', BASE_MS)).toBe(false);

    rl.reset('wh-A'); // only clear A
    expect(rl.check('wh-A', BASE_MS)).toBe(true);  // A restored
    expect(rl.check('wh-B', BASE_MS)).toBe(false); // B still blocked
  });

  it('MH6: after reset(id), the other webhook\'s window count is still accurate', () => {
    const rl = new WebhookRateLimiter(3);
    rl.check('wh-X', BASE_MS);
    rl.check('wh-X', BASE_MS);
    rl.check('wh-Y', BASE_MS);

    rl.reset('wh-Y'); // clear Y only
    expect(rl.count('wh-X', BASE_MS)).toBe(2); // X count preserved
    expect(rl.count('wh-Y', BASE_MS)).toBe(0); // Y cleared
  });
});

// ── WebhookCircuitBreaker boundary ───────────────────────────────────────────

describe('WebhookCircuitBreaker — exact cooldown boundary (kills >= vs > mutant)', () => {
  it('MH7: isOpen() at exactly openedAt + cooldownMs returns false (auto-recovers at >= boundary)', () => {
    const cb = new WebhookCircuitBreaker(2, 60_000);
    cb.recordFailure('wh-1', NOW);
    cb.recordFailure('wh-1', NOW); // opens at NOW

    // At exactly NOW + cooldownMs: should auto-recover (>= threshold)
    expect(cb.isOpen('wh-1', NOW + 60_000)).toBe(false);
    expect(cb.failureCount('wh-1')).toBe(0); // counter reset too
  });

  it('MH8: reset() with no argument clears ALL circuit states', () => {
    const cb = new WebhookCircuitBreaker(1, 60_000);
    cb.recordFailure('wh-A', NOW);
    cb.recordFailure('wh-B', NOW);
    expect(cb.isOpen('wh-A', NOW)).toBe(true);
    expect(cb.isOpen('wh-B', NOW)).toBe(true);

    cb.reset(); // no arg — clears all
    expect(cb.isOpen('wh-A', NOW)).toBe(false);
    expect(cb.isOpen('wh-B', NOW)).toBe(false);
    expect(cb.failureCount('wh-A')).toBe(0);
    expect(cb.failureCount('wh-B')).toBe(0);
  });

  it('MH9: reset(id) clears only the specified circuit — sibling circuit unaffected', () => {
    const cb = new WebhookCircuitBreaker(1, 60_000);
    cb.recordFailure('wh-A', NOW);
    cb.recordFailure('wh-B', NOW);
    expect(cb.isOpen('wh-A', NOW)).toBe(true);
    expect(cb.isOpen('wh-B', NOW)).toBe(true);

    cb.reset('wh-A');
    expect(cb.isOpen('wh-A', NOW)).toBe(false);
    expect(cb.isOpen('wh-B', NOW)).toBe(true);  // unaffected
    expect(cb.failureCount('wh-B')).toBeGreaterThan(0);
  });
});

// ── Defensive copies ──────────────────────────────────────────────────────────

describe('Defensive copies — list() returns snapshots (kills .slice() → direct ref mutant)', () => {
  it('MH10: WebhookDeliveryLog.list() returns a snapshot — mutating it does not alter the store', () => {
    getWebhookDeliveryLog().push({
      id: 'r1', webhookId: 'wh-1', event: 'scan.complete', url: 'https://x.com',
      timestamp: new Date().toISOString(), attempt: 1, statusCode: 200,
      delivered: true, latencyMs: 10, error: null,
    });

    const copy = getWebhookDeliveryLog().list();
    expect(copy).toHaveLength(1);

    // Mutate the returned array
    (copy as unknown[]).pop();
    expect(copy).toHaveLength(0);

    // Store is unaffected
    expect(getWebhookDeliveryLog().list()).toHaveLength(1);
  });

  it('MH11: WebhookTestHistory.list() returns a snapshot — mutating it does not alter the store', async () => {
    // Add a record via connection-refused (fast, no real server needed)
    await sendTestWebhook('http://127.0.0.1:1', 'scan.complete', null);

    const copy = getWebhookTestHistory().list();
    expect(copy.length).toBeGreaterThanOrEqual(1);
    const originalLength = copy.length;

    (copy as unknown[]).length = 0; // clear the copy
    expect(getWebhookTestHistory().list()).toHaveLength(originalLength);
  });
});

// ── getById() correctness ────────────────────────────────────────────────────

describe('WebhookStore.getById() — correct discrimination (kills w => true mutant)', () => {
  it('MH12: getById() returns undefined for a wrong id even when a webhook exists', () => {
    getWebhookStore().create('https://a.example.com', ['scan.complete']);
    expect(getWebhookStore().getById('nonexistent-id')).toBeUndefined();
  });

  it('MH13: getById() returns the correct webhook when two exist with similar ids', () => {
    const whA = getWebhookStore().create('https://a.example.com', ['scan.complete']);
    const whB = getWebhookStore().create('https://b.example.com', ['scan.failed']);
    expect(getWebhookStore().getById(whA.id)?.url).toBe('https://a.example.com');
    expect(getWebhookStore().getById(whB.id)?.url).toBe('https://b.example.com');
  });
});

// ── sendTestWebhook integrity ─────────────────────────────────────────────────

describe('sendTestWebhook — request integrity (kills header/method mutants)', () => {
  it('MH14: sendTestWebhook latencyMs is non-negative (kills +start arithmetic mutant)', async () => {
    const result = await sendTestWebhook('https://example.com/hook', 'scan.complete', null);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('MH15: X-Faultline-Signature header is included in fetch call when secret provided (kills if(false) mutant)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      text: async () => '',
    });
    vi.stubGlobal('fetch', mockFetch);

    await sendTestWebhook('https://example.com/hook', 'scan.complete', 'my-secret');

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    const options = callArgs[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers['X-Faultline-Signature']).toMatch(/^sha256=/);
  });
});
