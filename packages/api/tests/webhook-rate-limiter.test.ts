/**
 * N-113 — Webhook per-minute rate limiting
 *
 * WRL1–WRL8   WebhookRateLimiter unit: first dispatch allowed, within-limit
 *             allowed, at-limit boundary, over-limit blocked, window resets
 *             after 60 s, independent windows per webhook, reset() clears
 *             state, lower configurable threshold.
 * WRL9–WRL12  dispatchWebhook() integration: rate-limited call skips fetch,
 *             logs a delivery record with error='rate limited', delivered=false,
 *             statusCode=null; after window expiry delivery resumes.
 * WRL13–WRL15 Environment / cross-webhook: FAULTLINE_WEBHOOK_RATE_LIMIT env var
 *             controls default limit; one rate-limited webhook does not affect
 *             another; count() peek does not advance the counter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WebhookRateLimiter,
  getWebhookRateLimiter,
  resetWebhookRateLimiter,
  dispatchWebhook,
  _setSleepFn,
} from '../src/store/webhooks.js';
import { getWebhookDeliveryLog, resetWebhookDeliveryLog } from '../src/store/webhooks.js';
import { makeWebhook } from './helpers/make-webhook.js';

const BASE_MS = 1_000_000; // arbitrary fixed "now" for deterministic tests

beforeEach(() => {
  resetWebhookRateLimiter();
  resetWebhookDeliveryLog();
  _setSleepFn(async () => {}); // no delays
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── WebhookRateLimiter unit ───────────────────────────────────────────────────

describe('WebhookRateLimiter — unit', () => {
  it('WRL1: first dispatch for a webhook is always allowed', () => {
    const rl = new WebhookRateLimiter(10);
    expect(rl.check('wh-1', BASE_MS)).toBe(true);
  });

  it('WRL2: dispatches within the limit are all allowed', () => {
    const rl = new WebhookRateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(rl.check('wh-1', BASE_MS)).toBe(true);
    }
  });

  it('WRL3: the Nth dispatch (exactly at limit) is allowed; N+1 is blocked', () => {
    const rl = new WebhookRateLimiter(3);
    expect(rl.check('wh-1', BASE_MS)).toBe(true);  // 1
    expect(rl.check('wh-1', BASE_MS)).toBe(true);  // 2
    expect(rl.check('wh-1', BASE_MS)).toBe(true);  // 3 — at limit, still allowed
    expect(rl.check('wh-1', BASE_MS)).toBe(false); // 4 — over limit
  });

  it('WRL4: all dispatches over the limit are blocked', () => {
    const rl = new WebhookRateLimiter(2);
    rl.check('wh-1', BASE_MS);
    rl.check('wh-1', BASE_MS);
    // Over limit
    expect(rl.check('wh-1', BASE_MS)).toBe(false);
    expect(rl.check('wh-1', BASE_MS)).toBe(false);
    expect(rl.check('wh-1', BASE_MS)).toBe(false);
  });

  it('WRL5: window resets after 60 seconds — dispatch is allowed again', () => {
    const rl = new WebhookRateLimiter(2);
    rl.check('wh-1', BASE_MS);
    rl.check('wh-1', BASE_MS);
    expect(rl.check('wh-1', BASE_MS)).toBe(false); // over limit

    // 60 001 ms later — new window
    expect(rl.check('wh-1', BASE_MS + 60_001)).toBe(true);
  });

  it('WRL6: different webhooks have independent rate-limit windows', () => {
    const rl = new WebhookRateLimiter(1);
    rl.check('wh-A', BASE_MS); // wh-A exhausted
    expect(rl.check('wh-A', BASE_MS)).toBe(false);
    // wh-B is a separate window — unaffected
    expect(rl.check('wh-B', BASE_MS)).toBe(true);
  });

  it('WRL7: reset() clears state — dispatch allowed immediately after', () => {
    const rl = new WebhookRateLimiter(1);
    rl.check('wh-1', BASE_MS);
    expect(rl.check('wh-1', BASE_MS)).toBe(false); // blocked

    rl.reset('wh-1');
    expect(rl.check('wh-1', BASE_MS)).toBe(true); // allowed after reset
  });

  it('WRL8: constructor limit overrides default — lower threshold enforced', () => {
    const rl = new WebhookRateLimiter(2);
    expect(rl.limitPerMinute).toBe(2);
    rl.check('wh-1', BASE_MS);
    rl.check('wh-1', BASE_MS);
    expect(rl.check('wh-1', BASE_MS)).toBe(false);
  });
});

// ── dispatchWebhook() integration ─────────────────────────────────────────────

describe('dispatchWebhook() — rate limiter integration', () => {
  it('WRL9: rate-limited dispatch does NOT call fetch', async () => {
    const rl = getWebhookRateLimiter();
    const wh = makeWebhook();
    // Exhaust the limit using the actual singleton rate limiter
    for (let i = 0; i < rl.limitPerMinute; i++) {
      rl.check(wh.id);
    }

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await dispatchWebhook(wh, 'scan.complete', { test: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('WRL10: rate-limited dispatch logs a delivery record with error="rate limited"', async () => {
    const rl = getWebhookRateLimiter();
    const wh = makeWebhook();
    for (let i = 0; i < rl.limitPerMinute; i++) rl.check(wh.id);

    await dispatchWebhook(wh, 'scan.complete', {});

    const log = getWebhookDeliveryLog().list(wh.id);
    expect(log.length).toBeGreaterThanOrEqual(1);
    const rateLimitedRecord = log.find(r => r.error === 'rate limited');
    expect(rateLimitedRecord).toBeDefined();
    expect(rateLimitedRecord!.delivered).toBe(false);
    expect(rateLimitedRecord!.statusCode).toBeNull();
  });

  it('WRL11: rate-limited delivery record has attempt=1 and latencyMs=0', async () => {
    const rl = getWebhookRateLimiter();
    const wh = makeWebhook({ id: 'wh-rl11' });
    for (let i = 0; i < rl.limitPerMinute; i++) rl.check(wh.id);

    await dispatchWebhook(wh, 'scan.failed', {});

    const log = getWebhookDeliveryLog().list(wh.id);
    const record = log.find(r => r.error === 'rate limited');
    expect(record!.attempt).toBe(1);
    expect(record!.latencyMs).toBe(0);
    expect(record!.webhookId).toBe(wh.id);
    expect(record!.event).toBe('scan.failed');
  });

  it('WRL12: delivery resumes after rate limiter is reset', async () => {
    const rl = getWebhookRateLimiter();
    const wh = makeWebhook({ id: 'wh-rl12' });
    for (let i = 0; i < rl.limitPerMinute; i++) rl.check(wh.id);

    // Currently blocked
    await dispatchWebhook(wh, 'scan.complete', {});
    const blockedLog = getWebhookDeliveryLog().list(wh.id);
    expect(blockedLog.find(r => r.error === 'rate limited')).toBeDefined();

    // Reset and retry
    rl.reset(wh.id);
    resetWebhookDeliveryLog();
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await dispatchWebhook(wh, 'scan.complete', {});
    expect(mockFetch).toHaveBeenCalledOnce();
    const resumedLog = getWebhookDeliveryLog().list(wh.id);
    expect(resumedLog.find(r => r.delivered)).toBeDefined();
  });
});

// ── Environment / cross-webhook ───────────────────────────────────────────────

describe('WebhookRateLimiter — env + cross-webhook', () => {
  it('WRL13: FAULTLINE_WEBHOOK_RATE_LIMIT env var controls the default singleton limit', () => {
    process.env.FAULTLINE_WEBHOOK_RATE_LIMIT = '3';
    resetWebhookRateLimiter(); // re-create with new env value
    const rl = getWebhookRateLimiter();
    expect(rl.limitPerMinute).toBe(3);
    delete process.env.FAULTLINE_WEBHOOK_RATE_LIMIT;
    resetWebhookRateLimiter();
  });

  it('WRL14: rate-limiting wh-A does not affect wh-B delivery', async () => {
    const rl = getWebhookRateLimiter();
    const whA = makeWebhook({ id: 'wh-A-14' });
    const whB = makeWebhook({ id: 'wh-B-14' });

    // Exhaust wh-A
    for (let i = 0; i < rl.limitPerMinute; i++) rl.check(whA.id);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await dispatchWebhook(whB, 'scan.complete', {});
    expect(mockFetch).toHaveBeenCalledOnce(); // wh-B fires normally
  });

  it('WRL15: count() peeks at window without advancing — check() still works after', () => {
    const rl = new WebhookRateLimiter(3);
    rl.check('wh-1', BASE_MS);
    rl.check('wh-1', BASE_MS);

    // peek twice — should not advance
    expect(rl.count('wh-1', BASE_MS)).toBe(2);
    expect(rl.count('wh-1', BASE_MS)).toBe(2);

    // Third check() allowed (count was 2, not 4)
    expect(rl.check('wh-1', BASE_MS)).toBe(true);
    // Fourth blocked
    expect(rl.check('wh-1', BASE_MS)).toBe(false);
  });
});
