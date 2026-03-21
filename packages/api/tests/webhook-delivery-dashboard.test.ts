/**
 * N-109 — Webhook delivery log HTML dashboard
 *
 * WDV1–WDV5   Route basics: GET /webhooks/deliveries/view returns 200 with
 *             text/html, contains page title, contains stat cards, auto-refresh
 *             meta tag present, requires admin auth (401 without key).
 * WDV6–WDV8   Empty state: empty delivery log renders table with empty-state row,
 *             shows total=0 stat, no DELIVERED/FAILED chips in body.
 * WDV9–WDV11  DELIVERED record: DELIVERED chip present, HTTP status code shown,
 *             latency value in output.
 * WDV12–WDV14 FAILED record: FAILED chip present, error message shown,
 *             attempt number rendered in output.
 * WDV15       Multiple records: both DELIVERED and FAILED chips present when
 *             delivery log contains mixed results.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getWebhookDeliveryLog, resetWebhookDeliveryLog } from '../src/store/webhooks.js';
import type { WebhookDeliveryRecord } from '../src/store/webhooks.js';

beforeEach(() => {
  resetWebhookDeliveryLog();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<WebhookDeliveryRecord> = {}): WebhookDeliveryRecord {
  return {
    id:         overrides.id         ?? 'rec-test-id',
    webhookId:  overrides.webhookId  ?? 'wh-test-id',
    event:      overrides.event      ?? 'scan.complete',
    url:        overrides.url        ?? 'https://example.com/hook',
    timestamp:  overrides.timestamp  ?? new Date().toISOString(),
    attempt:    overrides.attempt    ?? 1,
    statusCode: overrides.statusCode ?? 200,
    delivered:  overrides.delivered  ?? true,
    latencyMs:  overrides.latencyMs  ?? 50,
    error:      overrides.error      ?? null,
  };
}

async function getHtmlBody(apiKey = 'test-key'): Promise<{ res: Awaited<ReturnType<typeof server.inject>>; server: Awaited<ReturnType<typeof buildServer>> }> {
  const { buildServer } = await import('../src/server.js');
  const server = buildServer();
  process.env.FAULTLINE_API_KEY = apiKey;
  const res = await server.inject({
    method: 'GET',
    url: '/webhooks/deliveries/view',
    headers: { 'x-api-key': apiKey },
  });
  await server.close();
  delete process.env.FAULTLINE_API_KEY;
  return { res, server };
}

// ── Route basics ──────────────────────────────────────────────────────────────

describe('GET /webhooks/deliveries/view — route basics', () => {
  it('WDV1: returns 200 with Content-Type text/html', async () => {
    const { res } = await getHtmlBody('test-wdv1');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('WDV2: HTML contains page title', async () => {
    const { res } = await getHtmlBody('test-wdv2');
    expect(res.body).toContain('Webhook Delivery Log');
  });

  it('WDV3: HTML contains 4 stat cards (Total/Delivered/Failed/Success Rate)', async () => {
    getWebhookDeliveryLog().push(makeRecord({ delivered: true }));
    getWebhookDeliveryLog().push(makeRecord({ id: 'r2', delivered: false, statusCode: 500 }));
    const { res } = await getHtmlBody('test-wdv3');
    expect(res.body).toContain('Total Attempts');
    expect(res.body).toContain('Delivered');
    expect(res.body).toContain('Failed');
    expect(res.body).toContain('Success Rate');
  });

  it('WDV4: auto-refresh meta tag present (30s)', async () => {
    const { res } = await getHtmlBody('test-wdv4');
    expect(res.body).toContain('http-equiv="refresh"');
    expect(res.body).toContain('content="30"');
  });

  it('WDV5: returns 401 without API key', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-wdv5';
    const res = await server.inject({ method: 'GET', url: '/webhooks/deliveries/view' });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    expect([401, 403]).toContain(res.statusCode);
  });
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe('GET /webhooks/deliveries/view — empty delivery log', () => {
  it('WDV6: empty log renders empty-state message in table', async () => {
    const { res } = await getHtmlBody('test-wdv6');
    expect(res.body).toContain('No delivery records yet');
  });

  it('WDV7: empty log shows zero in total stat', async () => {
    const { res } = await getHtmlBody('test-wdv7');
    // stat card value for 0 total — check it renders last 0 records
    expect(res.body).toContain('last 0');
  });

  it('WDV8: empty log has no DELIVERED or FAILED chip in body', async () => {
    const { res } = await getHtmlBody('test-wdv8');
    expect(res.body).not.toContain('chip delivered');
    expect(res.body).not.toContain('chip failed');
  });
});

// ── DELIVERED record ──────────────────────────────────────────────────────────

describe('GET /webhooks/deliveries/view — DELIVERED record', () => {
  it('WDV9: DELIVERED chip present for a successful delivery', async () => {
    getWebhookDeliveryLog().push(makeRecord({ delivered: true, statusCode: 200 }));
    const { res } = await getHtmlBody('test-wdv9');
    expect(res.body).toContain('chip delivered');
    expect(res.body).toContain('DELIVERED');
  });

  it('WDV10: HTTP status code shown for delivered record', async () => {
    getWebhookDeliveryLog().push(makeRecord({ delivered: true, statusCode: 201 }));
    const { res } = await getHtmlBody('test-wdv10');
    expect(res.body).toContain('201');
  });

  it('WDV11: latency value rendered for delivered record', async () => {
    getWebhookDeliveryLog().push(makeRecord({ delivered: true, latencyMs: 137 }));
    const { res } = await getHtmlBody('test-wdv11');
    expect(res.body).toContain('137ms');
  });
});

// ── FAILED record ─────────────────────────────────────────────────────────────

describe('GET /webhooks/deliveries/view — FAILED record', () => {
  it('WDV12: FAILED chip present for a failed delivery', async () => {
    getWebhookDeliveryLog().push(makeRecord({ delivered: false, statusCode: 503 }));
    const { res } = await getHtmlBody('test-wdv12');
    expect(res.body).toContain('chip failed');
    expect(res.body).toContain('FAILED');
  });

  it('WDV13: error message shown for network-error record', async () => {
    getWebhookDeliveryLog().push(makeRecord({ delivered: false, statusCode: null, error: 'ECONNREFUSED' }));
    const { res } = await getHtmlBody('test-wdv13');
    expect(res.body).toContain('ECONNREFUSED');
  });

  it('WDV14: attempt number rendered in table row', async () => {
    getWebhookDeliveryLog().push(makeRecord({ delivered: false, attempt: 3, statusCode: 500 }));
    const { res } = await getHtmlBody('test-wdv14');
    expect(res.body).toContain('#3');
  });
});

// ── Mixed results ─────────────────────────────────────────────────────────────

describe('GET /webhooks/deliveries/view — mixed results', () => {
  it('WDV15: both DELIVERED and FAILED chips present in mixed log', async () => {
    getWebhookDeliveryLog().push(makeRecord({ id: 'r1', delivered: true, statusCode: 200 }));
    getWebhookDeliveryLog().push(makeRecord({ id: 'r2', delivered: false, statusCode: 503 }));
    const { res } = await getHtmlBody('test-wdv15');
    expect(res.body).toContain('chip delivered');
    expect(res.body).toContain('chip failed');
    // Success rate should be 50%
    expect(res.body).toContain('50%');
  });
});
