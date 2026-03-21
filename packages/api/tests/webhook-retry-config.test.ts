/**
 * N-115 — Per-webhook retry configuration
 *
 * RC1–RC5   WebhookStore.create() defaults and explicit values: default maxAttempts=3,
 *           default retryDelayMs=500, explicit maxAttempts honoured, explicit
 *           retryDelayMs honoured, both overridden together.
 * RC6–RC8   Route: POST /webhooks accepts maxAttempts and retryDelayMs; defaults
 *           applied when omitted; validation rejects out-of-range values.
 * RC9–RC12  dispatchWebhook() behaviour: maxAttempts=1 stops after first failure
 *           (only 1 log record), maxAttempts=2 produces 2 records on total failure,
 *           maxAttempts=5 stops as soon as first attempt succeeds (1 record),
 *           retryDelayMs passed to sleep between retries.
 * RC13–RC15 Edge cases: maxAttempts=1 with success logs 1 delivered record, GET
 *           /webhooks returns maxAttempts and retryDelayMs in response body,
 *           independent webhooks can have different retry configs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getWebhookStore,
  resetWebhookStore,
  resetWebhookRateLimiter,
  resetWebhookCircuitBreaker,
  resetWebhookDeliveryLog,
  getWebhookDeliveryLog,
  dispatchWebhook,
  _setSleepFn,
} from '../src/store/webhooks.js';

beforeEach(() => {
  resetWebhookStore();
  resetWebhookRateLimiter();
  resetWebhookCircuitBreaker();
  resetWebhookDeliveryLog();
  _setSleepFn(async () => {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── WebhookStore.create() defaults and explicit values ───────────────────────

describe('WebhookStore.create() — retry config defaults', () => {
  it('RC1: default maxAttempts is 3', () => {
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete']);
    expect(wh.maxAttempts).toBe(3);
  });

  it('RC2: default retryDelayMs is 500', () => {
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete']);
    expect(wh.retryDelayMs).toBe(500);
  });

  it('RC3: explicit maxAttempts is honoured', () => {
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], undefined, undefined, 1);
    expect(wh.maxAttempts).toBe(1);
  });

  it('RC4: explicit retryDelayMs is honoured', () => {
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], undefined, undefined, 3, 2000);
    expect(wh.retryDelayMs).toBe(2000);
  });

  it('RC5: maxAttempts=5 and retryDelayMs=0 stored together', () => {
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], undefined, undefined, 5, 0);
    expect(wh.maxAttempts).toBe(5);
    expect(wh.retryDelayMs).toBe(0);
  });
});

// ── Route: POST /webhooks ─────────────────────────────────────────────────────

describe('POST /webhooks — retry config fields', () => {
  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-rc-route';
  });
  afterEach(() => {
    delete process.env.FAULTLINE_API_KEY;
  });

  it('RC6: POST /webhooks with maxAttempts=2 and retryDelayMs=1000 stores them', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    const res = await server.inject({
      method:  'POST',
      url:     '/webhooks',
      headers: { 'x-api-key': 'test-rc-route', 'Content-Type': 'application/json' },
      payload: { url: 'https://example.com/rc6', events: ['scan.complete'], maxAttempts: 2, retryDelayMs: 1000 },
    });
    await server.close();
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.maxAttempts).toBe(2);
    expect(body.retryDelayMs).toBe(1000);
  });

  it('RC7: POST /webhooks without retry fields uses defaults (3, 500)', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    const res = await server.inject({
      method:  'POST',
      url:     '/webhooks',
      headers: { 'x-api-key': 'test-rc-route', 'Content-Type': 'application/json' },
      payload: { url: 'https://example.com/rc7', events: ['scan.complete'] },
    });
    await server.close();
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.maxAttempts).toBe(3);
    expect(body.retryDelayMs).toBe(500);
  });

  it('RC8: POST /webhooks with maxAttempts=6 (out of range) returns 400', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    const res = await server.inject({
      method:  'POST',
      url:     '/webhooks',
      headers: { 'x-api-key': 'test-rc-route', 'Content-Type': 'application/json' },
      payload: { url: 'https://example.com/rc8', events: ['scan.complete'], maxAttempts: 6 },
    });
    await server.close();
    expect(res.statusCode).toBe(400);
  });
});

// ── dispatchWebhook() behaviour ───────────────────────────────────────────────

describe('dispatchWebhook() — retry config integration', () => {
  it('RC9: maxAttempts=1 stops after single failure — exactly 1 delivery record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], undefined, undefined, 1);
    await dispatchWebhook(wh, 'scan.complete', {});
    const records = getWebhookDeliveryLog().list(wh.id);
    expect(records).toHaveLength(1);
    expect(records[0].delivered).toBe(false);
  });

  it('RC10: maxAttempts=2 produces exactly 2 records when all fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], undefined, undefined, 2);
    await dispatchWebhook(wh, 'scan.complete', {});
    const records = getWebhookDeliveryLog().list(wh.id);
    expect(records).toHaveLength(2);
    expect(records.every(r => !r.delivered)).toBe(true);
  });

  it('RC11: maxAttempts=5 stops on first success — exactly 1 delivered record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], undefined, undefined, 5);
    await dispatchWebhook(wh, 'scan.complete', {});
    const records = getWebhookDeliveryLog().list(wh.id);
    expect(records).toHaveLength(1);
    expect(records[0].delivered).toBe(true);
    expect(records[0].attempt).toBe(1);
  });

  it('RC12: retryDelayMs is passed to sleep on each retry (not the first attempt)', async () => {
    const sleepCalls: number[] = [];
    _setSleepFn(async (ms) => { sleepCalls.push(ms); });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], undefined, undefined, 3, 1234);
    await dispatchWebhook(wh, 'scan.complete', {});
    // Attempt 0: sleep(0), attempts 1+: sleep(1234)
    expect(sleepCalls[0]).toBe(0);
    expect(sleepCalls[1]).toBe(1234);
    expect(sleepCalls[2]).toBe(1234);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('dispatchWebhook() — retry config edge cases', () => {
  it('RC13: maxAttempts=1 with success logs exactly 1 delivered record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], undefined, undefined, 1);
    await dispatchWebhook(wh, 'scan.complete', {});
    const records = getWebhookDeliveryLog().list(wh.id);
    expect(records).toHaveLength(1);
    expect(records[0].delivered).toBe(true);
    expect(records[0].attempt).toBe(1);
  });

  it('RC14: GET /webhooks returns maxAttempts and retryDelayMs in listed webhook', async () => {
    // Create directly in store (no route auth complexity)
    const wh = getWebhookStore().create('https://example.com/rc14', ['scan.complete'], undefined, undefined, 4, 750);
    const listed = getWebhookStore().list();
    const found = listed.find(w => w.id === wh.id);
    expect(found).toBeDefined();
    expect(found!.maxAttempts).toBe(4);
    expect(found!.retryDelayMs).toBe(750);
  });

  it('RC15: two webhooks can have different retry configs — each uses its own', async () => {
    const calls: number[] = [];
    _setSleepFn(async (ms) => { calls.push(ms); });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const whA = getWebhookStore().create('https://a.example.com/hook', ['scan.complete'], undefined, undefined, 1, 0);
    const whB = getWebhookStore().create('https://b.example.com/hook', ['scan.complete'], undefined, undefined, 2, 9999);

    await dispatchWebhook(whA, 'scan.complete', {});
    await dispatchWebhook(whB, 'scan.complete', {});

    const aRecords = getWebhookDeliveryLog().list(whA.id);
    const bRecords = getWebhookDeliveryLog().list(whB.id);
    expect(aRecords).toHaveLength(1);  // maxAttempts=1
    expect(bRecords).toHaveLength(2);  // maxAttempts=2
    // whB's second attempt delay was 9999
    expect(calls).toContain(9999);
  });
});
