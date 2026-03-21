/**
 * N-106 — Webhook delivery retry dashboard
 *
 * WDL1–WDL8   WebhookDeliveryLog store: record on success, record on failure,
 *             record on network error, attempt number, webhookId filter,
 *             global list, limit param, ring-buffer cap.
 * WDL9–WDL12  dispatchWebhook integration: delivery log populated after dispatch,
 *             failed delivery logged (not delivered), all 3 retry attempts logged,
 *             delivered flag set correctly.
 * WDL13–WDL15 Route integration: GET /webhooks/deliveries, GET /webhooks/:id/deliveries,
 *             404 for unknown webhook.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getWebhookDeliveryLog,
  resetWebhookDeliveryLog,
  getWebhookStore,
  resetWebhookStore,
  dispatchWebhook,
  _setSleepFn,
} from '../src/store/webhooks.js';
import type { Webhook, WebhookEvent } from '../src/store/webhooks.js';

function makeWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id:        overrides.id        ?? 'wh-test-id',
    url:       overrides.url       ?? 'https://example.com/hook',
    events:    overrides.events    ?? ['scan.complete'],
    secret:    overrides.secret    ?? 'test-secret',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

beforeEach(() => {
  resetWebhookDeliveryLog();
  resetWebhookStore();
  _setSleepFn(async () => {}); // no delays in tests
  vi.restoreAllMocks();
});

// ── WebhookDeliveryLog store ──────────────────────────────────────────────────

describe('WebhookDeliveryLog — store', () => {
  it('WDL1: push() stores a delivery record', () => {
    getWebhookDeliveryLog().push({
      id: 'r1', webhookId: 'wh1', event: 'scan.complete', url: 'https://x',
      timestamp: new Date().toISOString(), attempt: 1,
      statusCode: 200, delivered: true, latencyMs: 50, error: null,
    });
    expect(getWebhookDeliveryLog().list()).toHaveLength(1);
  });

  it('WDL2: delivered:false stored when delivery fails', () => {
    getWebhookDeliveryLog().push({
      id: 'r2', webhookId: 'wh1', event: 'scan.failed', url: 'https://x',
      timestamp: new Date().toISOString(), attempt: 1,
      statusCode: 500, delivered: false, latencyMs: 100, error: null,
    });
    const records = getWebhookDeliveryLog().list();
    expect(records[0].delivered).toBe(false);
    expect(records[0].statusCode).toBe(500);
  });

  it('WDL3: network error stored with error string and null statusCode', () => {
    getWebhookDeliveryLog().push({
      id: 'r3', webhookId: 'wh1', event: 'scan.complete', url: 'https://x',
      timestamp: new Date().toISOString(), attempt: 1,
      statusCode: null, delivered: false, latencyMs: 0, error: 'ECONNREFUSED',
    });
    const records = getWebhookDeliveryLog().list();
    expect(records[0].statusCode).toBeNull();
    expect(records[0].error).toBe('ECONNREFUSED');
  });

  it('WDL4: webhookId filter returns only that webhook\'s records', () => {
    for (const whId of ['wh-a', 'wh-b', 'wh-a']) {
      getWebhookDeliveryLog().push({
        id: `r-${whId}-${Math.random()}`, webhookId: whId, event: 'scan.complete',
        url: 'https://x', timestamp: new Date().toISOString(), attempt: 1,
        statusCode: 200, delivered: true, latencyMs: 10, error: null,
      });
    }
    expect(getWebhookDeliveryLog().list('wh-a')).toHaveLength(2);
    expect(getWebhookDeliveryLog().list('wh-b')).toHaveLength(1);
  });

  it('WDL5: list() without filter returns all records', () => {
    for (let i = 0; i < 5; i++) {
      getWebhookDeliveryLog().push({
        id: `r${i}`, webhookId: `wh${i}`, event: 'scan.complete', url: 'https://x',
        timestamp: new Date().toISOString(), attempt: 1,
        statusCode: 200, delivered: true, latencyMs: 10, error: null,
      });
    }
    expect(getWebhookDeliveryLog().list()).toHaveLength(5);
  });

  it('WDL6: limit parameter caps the returned records', () => {
    for (let i = 0; i < 10; i++) {
      getWebhookDeliveryLog().push({
        id: `r${i}`, webhookId: 'wh1', event: 'scan.complete', url: 'https://x',
        timestamp: new Date().toISOString(), attempt: 1,
        statusCode: 200, delivered: true, latencyMs: 10, error: null,
      });
    }
    expect(getWebhookDeliveryLog().list(undefined, 3)).toHaveLength(3);
  });

  it('WDL7: records stored newest-first', () => {
    getWebhookDeliveryLog().push({ id: 'old', webhookId: 'wh1', event: 'scan.complete', url: 'https://x', timestamp: '2026-01-01T00:00:00Z', attempt: 1, statusCode: 200, delivered: true, latencyMs: 10, error: null });
    getWebhookDeliveryLog().push({ id: 'new', webhookId: 'wh1', event: 'scan.complete', url: 'https://x', timestamp: '2026-01-02T00:00:00Z', attempt: 1, statusCode: 200, delivered: true, latencyMs: 10, error: null });
    expect(getWebhookDeliveryLog().list()[0].id).toBe('new');
  });

  it('WDL8: ring buffer caps at 1000 records', () => {
    for (let i = 0; i < 1010; i++) {
      getWebhookDeliveryLog().push({
        id: `r${i}`, webhookId: 'wh1', event: 'scan.complete', url: 'https://x',
        timestamp: new Date().toISOString(), attempt: 1,
        statusCode: 200, delivered: true, latencyMs: 1, error: null,
      });
    }
    expect(getWebhookDeliveryLog().list(undefined, 2000)).toHaveLength(1000);
  });
});

// ── dispatchWebhook integration ───────────────────────────────────────────────

describe('dispatchWebhook — delivery log integration', () => {
  it('WDL9: successful dispatch logs one record with delivered:true', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const wh = makeWebhook();
    await dispatchWebhook(wh, 'scan.complete', { test: true });
    const records = getWebhookDeliveryLog().list('wh-test-id');
    expect(records).toHaveLength(1);
    expect(records[0].delivered).toBe(true);
    expect(records[0].statusCode).toBe(200);
    expect(records[0].attempt).toBe(1);
  });

  it('WDL10: failed dispatch (non-ok status) logs record with delivered:false', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);
    const wh = makeWebhook();
    await dispatchWebhook(wh, 'scan.complete', { test: true });
    const records = getWebhookDeliveryLog().list('wh-test-id');
    expect(records.some((r) => !r.delivered)).toBe(true);
  });

  it('WDL11: all 3 retry attempts logged when all fail', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    const wh = makeWebhook();
    await dispatchWebhook(wh, 'scan.complete', { test: true });
    const records = getWebhookDeliveryLog().list('wh-test-id');
    expect(records).toHaveLength(3);
    const attempts = records.map((r) => r.attempt).sort();
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('WDL12: network error logged with error string and null statusCode', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const wh = makeWebhook();
    await dispatchWebhook(wh, 'scan.complete', { test: true });
    const records = getWebhookDeliveryLog().list('wh-test-id');
    expect(records.some((r) => r.error === 'ECONNREFUSED')).toBe(true);
    expect(records.some((r) => r.statusCode === null)).toBe(true);
  });
});

// ── Route integration ─────────────────────────────────────────────────────────

describe('GET /webhooks/deliveries — route', () => {
  it('WDL13: returns delivery records with failedCount summary', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-wdl13';

    getWebhookDeliveryLog().push({ id: 'r1', webhookId: 'wh1', event: 'scan.complete', url: 'https://x', timestamp: new Date().toISOString(), attempt: 1, statusCode: 200, delivered: true, latencyMs: 10, error: null });
    getWebhookDeliveryLog().push({ id: 'r2', webhookId: 'wh1', event: 'scan.failed', url: 'https://x', timestamp: new Date().toISOString(), attempt: 3, statusCode: 500, delivered: false, latencyMs: 50, error: null });

    const res = await server.inject({ method: 'GET', url: '/webhooks/deliveries', headers: { 'x-api-key': 'test-wdl13' } });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.failedCount).toBe(1);
    expect(Array.isArray(body.records)).toBe(true);
  });

  it('WDL14: GET /webhooks/:id/deliveries returns scoped records', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-wdl14';

    // Create a real webhook in the store so :id route can find it
    const wh = getWebhookStore().create('https://example.com', ['scan.complete']);
    getWebhookDeliveryLog().push({ id: 'rA', webhookId: wh.id, event: 'scan.complete', url: 'https://example.com', timestamp: new Date().toISOString(), attempt: 1, statusCode: 200, delivered: true, latencyMs: 10, error: null });
    getWebhookDeliveryLog().push({ id: 'rB', webhookId: 'other-wh', event: 'scan.complete', url: 'https://other', timestamp: new Date().toISOString(), attempt: 1, statusCode: 200, delivered: true, latencyMs: 10, error: null });

    const res = await server.inject({ method: 'GET', url: `/webhooks/${wh.id}/deliveries`, headers: { 'x-api-key': 'test-wdl14' } });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.webhookId).toBe(wh.id);
    expect(body.total).toBe(1);
    expect(body.records[0].id).toBe('rA');
  });

  it('WDL15: GET /webhooks/:id/deliveries returns 404 for unknown webhook', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-wdl15';

    const res = await server.inject({ method: 'GET', url: '/webhooks/nonexistent-id/deliveries', headers: { 'x-api-key': 'test-wdl15' } });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;

    expect(res.statusCode).toBe(404);
  });
});
