/**
 * N-114 — Webhook circuit breaker
 *
 * CB1–CB7   WebhookCircuitBreaker unit: circuit starts closed, single failure
 *           stays closed, N-1 failures stay closed, Nth failure opens circuit,
 *           open circuit stays open within cooldown, auto-recovers after
 *           cooldown, success resets failure counter.
 * CB8–CB9   Configurable threshold and cooldown duration.
 * CB10–CB13 dispatchWebhook() integration: open circuit skips fetch, logs
 *           delivery record with error='circuit open'; dispatchWebhook()
 *           calls recordFailure after all 3 retries exhausted; calls
 *           recordSuccess after successful delivery.
 * CB14–CB15 Cross-webhook isolation and reset().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WebhookCircuitBreaker,
  getWebhookCircuitBreaker,
  resetWebhookCircuitBreaker,
  dispatchWebhook,
  _setSleepFn,
} from '../src/store/webhooks.js';
import { getWebhookDeliveryLog, resetWebhookDeliveryLog } from '../src/store/webhooks.js';
import type { Webhook } from '../src/store/webhooks.js';

const NOW = 2_000_000; // fixed clock base for deterministic tests

function makeWebhook(id = 'wh-cb-test'): Webhook {
  return {
    id,
    url:          'https://example.com/hook',
    events:       ['scan.complete'],
    secret:       'secret',
    tenantId:     undefined,
    maxAttempts:  3,
    retryDelayMs: 500,
    createdAt:    new Date().toISOString(),
  };
}

beforeEach(() => {
  resetWebhookCircuitBreaker();
  resetWebhookDeliveryLog();
  _setSleepFn(async () => {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── WebhookCircuitBreaker unit ────────────────────────────────────────────────

describe('WebhookCircuitBreaker — unit', () => {
  it('CB1: circuit starts closed for any webhookId', () => {
    const cb = new WebhookCircuitBreaker(3, 60_000);
    expect(cb.isOpen('wh-1', NOW)).toBe(false);
  });

  it('CB2: a single failure does not open the circuit', () => {
    const cb = new WebhookCircuitBreaker(3, 60_000);
    cb.recordFailure('wh-1', NOW);
    expect(cb.isOpen('wh-1', NOW)).toBe(false);
    expect(cb.failureCount('wh-1')).toBe(1);
  });

  it('CB3: N-1 consecutive failures keep the circuit closed', () => {
    const cb = new WebhookCircuitBreaker(5, 60_000);
    for (let i = 0; i < 4; i++) cb.recordFailure('wh-1', NOW);
    expect(cb.isOpen('wh-1', NOW)).toBe(false);
    expect(cb.failureCount('wh-1')).toBe(4);
  });

  it('CB4: the Nth consecutive failure opens the circuit', () => {
    const cb = new WebhookCircuitBreaker(3, 60_000);
    cb.recordFailure('wh-1', NOW);
    cb.recordFailure('wh-1', NOW);
    cb.recordFailure('wh-1', NOW); // 3rd — threshold reached
    expect(cb.isOpen('wh-1', NOW)).toBe(true);
  });

  it('CB5: open circuit stays open within the cooldown window', () => {
    const cb = new WebhookCircuitBreaker(2, 60_000);
    cb.recordFailure('wh-1', NOW);
    cb.recordFailure('wh-1', NOW); // opens at NOW
    expect(cb.isOpen('wh-1', NOW + 59_999)).toBe(true); // still within window
  });

  it('CB6: circuit auto-recovers to closed after cooldown elapses', () => {
    const cb = new WebhookCircuitBreaker(2, 60_000);
    cb.recordFailure('wh-1', NOW);
    cb.recordFailure('wh-1', NOW); // opens at NOW
    expect(cb.isOpen('wh-1', NOW + 60_001)).toBe(false); // past cooldown
    expect(cb.failureCount('wh-1')).toBe(0); // counter reset
  });

  it('CB7: success resets the failure counter — circuit stays closed', () => {
    const cb = new WebhookCircuitBreaker(3, 60_000);
    cb.recordFailure('wh-1', NOW);
    cb.recordFailure('wh-1', NOW); // 2 of 3
    cb.recordSuccess('wh-1');      // reset
    expect(cb.failureCount('wh-1')).toBe(0);
    // Two more failures after reset should not open (threshold is 3)
    cb.recordFailure('wh-1', NOW);
    cb.recordFailure('wh-1', NOW);
    expect(cb.isOpen('wh-1', NOW)).toBe(false);
  });
});

// ── Configurable threshold and cooldown ──────────────────────────────────────

describe('WebhookCircuitBreaker — configuration', () => {
  it('CB8: configurable failure threshold is enforced', () => {
    const cb = new WebhookCircuitBreaker(1, 60_000); // trip on first failure
    cb.recordFailure('wh-1', NOW);
    expect(cb.isOpen('wh-1', NOW)).toBe(true);
  });

  it('CB9: configurable cooldown duration controls recovery time', () => {
    const cb = new WebhookCircuitBreaker(2, 5_000); // 5 s cooldown
    cb.recordFailure('wh-1', NOW);
    cb.recordFailure('wh-1', NOW);
    expect(cb.isOpen('wh-1', NOW + 4_999)).toBe(true);  // still open
    expect(cb.isOpen('wh-1', NOW + 5_001)).toBe(false); // recovered
  });
});

// ── dispatchWebhook() integration ─────────────────────────────────────────────

describe('dispatchWebhook() — circuit breaker integration', () => {
  it('CB10: open circuit causes dispatchWebhook to skip fetch entirely', async () => {
    const cb = getWebhookCircuitBreaker();
    const wh = makeWebhook('wh-cb10');
    // Manually trip the circuit by recording threshold failures
    for (let i = 0; i < cb.failureThreshold; i++) {
      cb.recordFailure(wh.id);
    }

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await dispatchWebhook(wh, 'scan.complete', {});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('CB11: open circuit logs a delivery record with error="circuit open"', async () => {
    const cb = getWebhookCircuitBreaker();
    const wh = makeWebhook('wh-cb11');
    for (let i = 0; i < cb.failureThreshold; i++) cb.recordFailure(wh.id);

    await dispatchWebhook(wh, 'scan.failed', {});

    const log = getWebhookDeliveryLog().list(wh.id);
    const record = log.find(r => r.error === 'circuit open');
    expect(record).toBeDefined();
    expect(record!.delivered).toBe(false);
    expect(record!.statusCode).toBeNull();
    expect(record!.attempt).toBe(1);
    expect(record!.latencyMs).toBe(0);
  });

  it('CB12: all-failed dispatch increments circuit failure counter', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const cb = getWebhookCircuitBreaker();
    const wh = makeWebhook('wh-cb12');

    await dispatchWebhook(wh, 'scan.complete', {});
    expect(cb.failureCount(wh.id)).toBe(1);
  });

  it('CB13: successful dispatch records success and resets failure counter', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const cb = getWebhookCircuitBreaker();
    const wh = makeWebhook('wh-cb13');

    // Seed some failures first
    cb.recordFailure(wh.id);
    cb.recordFailure(wh.id);
    expect(cb.failureCount(wh.id)).toBe(2);

    await dispatchWebhook(wh, 'scan.complete', {});
    expect(cb.failureCount(wh.id)).toBe(0); // success reset
  });
});

// ── Cross-webhook isolation and reset ────────────────────────────────────────

describe('WebhookCircuitBreaker — isolation + reset', () => {
  it('CB14: open circuit on wh-A does not affect wh-B', async () => {
    const cb = getWebhookCircuitBreaker();
    const whA = makeWebhook('wh-A-cb14');
    const whB = makeWebhook('wh-B-cb14');

    for (let i = 0; i < cb.failureThreshold; i++) cb.recordFailure(whA.id);
    expect(cb.isOpen(whA.id)).toBe(true);
    expect(cb.isOpen(whB.id)).toBe(false);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await dispatchWebhook(whB, 'scan.complete', {});
    expect(mockFetch).toHaveBeenCalledOnce(); // wh-B fires normally
  });

  it('CB15: reset() clears circuit state — dispatch resumes', async () => {
    const cb = getWebhookCircuitBreaker();
    const wh = makeWebhook('wh-cb15');
    for (let i = 0; i < cb.failureThreshold; i++) cb.recordFailure(wh.id);
    expect(cb.isOpen(wh.id)).toBe(true);

    cb.reset(wh.id);
    expect(cb.isOpen(wh.id)).toBe(false);
    expect(cb.failureCount(wh.id)).toBe(0);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    await dispatchWebhook(wh, 'scan.complete', {});
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
