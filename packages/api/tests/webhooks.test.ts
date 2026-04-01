import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildServer } from '../src/server.js';
import {
  getWebhookStore,
  resetWebhookStore,
  dispatchWebhook,
  fireWebhookEvent,
  _setSleepFn,
} from '../src/store/webhooks.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import type { FastifyInstance } from 'fastify';

const MOCK_SCAN_RESULT = {
  input: 'claim text',
  provider: 'mock',
  claims: [{ id: 'c1', text: 'claim', type: 'fact', importance: 3 }],
  verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] } },
  overallRisk: 'low',
  complianceReport: { riskTier: 'minimal', findings: [] } as any,
  ruleFindings: [],
};

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({
    input: 'claim text',
    provider: 'mock',
    claims: [{ id: 'c1', text: 'claim', type: 'fact', importance: 3 }],
    verifications: { c1: { claimId: 'c1', status: 'unverified', explanation: '', sources: [] } },
    overallRisk: 'low',
    complianceReport: { riskTier: 'minimal', findings: [] },
    ruleFindings: [],
  }),
}));

function resetAll() {
  process.env.FAULTLINE_API_KEY = 'admin-secret';
  resetWebhookStore();
  resetKeyStore();
  resetRateLimiter();
  resetAuditLogger();
  resetUsageMeter();
  resetAnalytics();
  resetCache();
}

// ─── CRUD Tests ────────────────────────────────────────────────────────────

describe('Webhook CRUD routes', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
    server = buildServer();
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('C1. POST /webhooks returns 201 with id, url, events, secret, createdAt', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', events: ['scan.complete'] }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.url).toBe('https://example.com/hook');
    expect(body.events).toContain('scan.complete');
    expect(body.secret).toBeDefined();
    expect(body.createdAt).toBeDefined();
  });

  it('C2. auto-generated secret is 64-char hex', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', events: ['scan.complete'] }),
    });
    expect(JSON.parse(res.body).secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('C3. provided secret echoed back verbatim', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', events: ['scan.complete'], secret: 'my-custom-secret' }),
    });
    expect(JSON.parse(res.body).secret).toBe('my-custom-secret');
  });

  it('C4. GET /webhooks returns 200 with array', async () => {
    const res = await server.inject({ method: 'GET', url: '/webhooks', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });

  it('C5. GET /webhooks omits secret field', async () => {
    await server.inject({
      method: 'POST', url: '/webhooks',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', events: ['scan.complete'] }),
    });
    const res = await server.inject({ method: 'GET', url: '/webhooks', headers: { 'x-api-key': 'admin-secret' } });
    const list = JSON.parse(res.body);
    expect(list[0].secret).toBeUndefined();
  });

  it('C6. GET /webhooks list grows after each POST (Gate 2: length = 2)', async () => {
    for (let i = 0; i < 2; i++) {
      await server.inject({
        method: 'POST', url: '/webhooks',
        headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ url: `https://example.com/hook${i}`, events: ['scan.complete'] }),
      });
    }
    const res = await server.inject({ method: 'GET', url: '/webhooks', headers: { 'x-api-key': 'admin-secret' } });
    expect(JSON.parse(res.body).length).toBe(2);
  });

  it('C7. DELETE /webhooks/:id returns 204', async () => {
    const created = JSON.parse((await server.inject({
      method: 'POST', url: '/webhooks',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', events: ['scan.complete'] }),
    })).body);
    const res = await server.inject({ method: 'DELETE', url: `/webhooks/${created.id}`, headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(204);
  });

  it('C8. DELETE removes entry from GET list', async () => {
    const created = JSON.parse((await server.inject({
      method: 'POST', url: '/webhooks',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', events: ['scan.complete'] }),
    })).body);
    await server.inject({ method: 'DELETE', url: `/webhooks/${created.id}`, headers: { 'x-api-key': 'admin-secret' } });
    const res = await server.inject({ method: 'GET', url: '/webhooks', headers: { 'x-api-key': 'admin-secret' } });
    expect(JSON.parse(res.body).length).toBe(0);
  });

  it('C9. DELETE non-existent id returns 404', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/webhooks/no-such-id', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBeDefined();
  });

  it('C10. POST /webhooks rejects invalid event value → 400', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/hook', events: ['bad.event'] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('C11. POST /webhooks rejects missing url → 400', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ events: ['scan.complete'] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('C12. all three routes return 403 for non-admin key', async () => {
    const scanKey = getKeyStore().create('Scan Only', ['scan']);
    const jsonHeaders = { 'x-api-key': scanKey.key, 'content-type': 'application/json' };
    const [r1, r2, r3] = await Promise.all([
      server.inject({ method: 'POST', url: '/webhooks', headers: jsonHeaders, body: JSON.stringify({ url: 'https://x.com', events: ['scan.complete'] }) }),
      server.inject({ method: 'GET', url: '/webhooks', headers: { 'x-api-key': scanKey.key } }),
      server.inject({ method: 'DELETE', url: '/webhooks/any-id', headers: { 'x-api-key': scanKey.key } }),
    ]);
    expect(r1.statusCode).toBe(403);
    expect(r2.statusCode).toBe(403);
    expect(r3.statusCode).toBe(403);
  });
});

// ─── Dispatch Tests ────────────────────────────────────────────────────────

describe('Webhook dispatch', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    resetAll();
    _setSleepFn(async () => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    server = buildServer();
    await server.ready();
    // Allow npm metrics auto-poll fetch to settle before clearing
    await new Promise(r => setTimeout(r, 10));
    vi.mocked(fetch).mockClear();
  });

  afterEach(async () => {
    await server.close();
    vi.unstubAllGlobals();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('D1. fireWebhookEvent calls fetch for matching webhook', async () => {
    getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    fireWebhookEvent('scan.complete', {});
    // allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0);
  });

  it('D2. fireWebhookEvent does NOT call fetch for non-matching event', async () => {
    getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    fireWebhookEvent('scan.failed', {});
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('D3. fetch called with POST method and Content-Type application/json', async () => {
    getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    fireWebhookEvent('scan.complete', {});
    await new Promise((r) => setTimeout(r, 10));
    const [_url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('D4. X-Faultline-Signature header present and starts with sha256=', async () => {
    getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    fireWebhookEvent('scan.complete', {});
    await new Promise((r) => setTimeout(r, 10));
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const sig = (init.headers as Record<string, string>)['X-Faultline-Signature'];
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('D5. HMAC signature is correct for known secret+body', async () => {
    const secret = 'test-secret-known';
    const webhook = getWebhookStore().create('https://example.com/hook', ['scan.complete'], secret);
    const data = { test: 'value' };
    const timestamp = '2026-03-18T00:00:00.000Z';
    await dispatchWebhook(webhook, 'scan.complete', data, timestamp);
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    const expected = 'sha256=' + createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
    const actual = (init.headers as Record<string, string>)['X-Faultline-Signature'];
    expect(actual).toBe(expected);
  });

  it('D6. POST /scan 200 triggers scan.complete event to registered webhook', async () => {
    getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    await server.inject({
      method: 'POST', url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(fetch)).toHaveBeenCalled();
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);
    expect(payload.event).toBe('scan.complete');
  });

  it('D7. POST /scan 500 (scan throws) triggers scan.failed event', async () => {
    const { scan } = await import('@nxtg/faultline/cli/scan.js');
    // With failover, all 5 providers must fail to trigger scan.failed.
    vi.mocked(scan)
      .mockRejectedValueOnce(new Error('Provider failure'))
      .mockRejectedValueOnce(new Error('Provider failure'))
      .mockRejectedValueOnce(new Error('Provider failure'))
      .mockRejectedValueOnce(new Error('Provider failure'))
      .mockRejectedValueOnce(new Error('Provider failure'));
    getWebhookStore().create('https://example.com/hook', ['scan.failed'], 'secret');
    await server.inject({
      method: 'POST', url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(fetch)).toHaveBeenCalled();
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).event).toBe('scan.failed');
  });

  it('D8. dispatch is fire-and-forget — /scan response does not wait for fetch', async () => {
    // fetch returns a never-resolving promise
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Some claim text.' }),
    });
    // Response arrived even though fetch never resolves
    expect(res.statusCode).toBe(200);
  });

  it('D9. two webhooks subscribed to same event both receive dispatch', async () => {
    getWebhookStore().create('https://example.com/hook1', ['scan.complete'], 'secret1');
    getWebhookStore().create('https://example.com/hook2', ['scan.complete'], 'secret2');
    fireWebhookEvent('scan.complete', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
  });

  it('D10. empty webhook store — fireWebhookEvent fires nothing', async () => {
    fireWebhookEvent('scan.complete', {});
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ─── Retry + Store Unit Tests ──────────────────────────────────────────────

describe('Webhook retry logic', () => {
  let sleepFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetAll();
    sleepFn = vi.fn().mockResolvedValue(undefined);
    _setSleepFn(sleepFn as (ms: number) => Promise<void>);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('R1. succeeds on first attempt — fetch called exactly once', async () => {
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    await dispatchWebhook(wh, 'scan.complete', {});
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it('R2. retries once on first failure — fetch called twice on recovery', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true }),
    );
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    await dispatchWebhook(wh, 'scan.complete', {});
    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
  });

  it('R3. retries to max 3 attempts when all fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    await dispatchWebhook(wh, 'scan.complete', {});
    expect(vi.mocked(fetch).mock.calls.length).toBe(3);
  });

  it('R4. all 3 failures silently swallowed — no throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    await expect(dispatchWebhook(wh, 'scan.complete', {})).resolves.toBeUndefined();
  });

  it('R5. sleep called with 0ms before attempt 0', async () => {
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    await dispatchWebhook(wh, 'scan.complete', {});
    expect(sleepFn.mock.calls[0][0]).toBe(0);
  });

  it('R6. sleep called with 500ms before attempt 1 (after first failure)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true }),
    );
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    await dispatchWebhook(wh, 'scan.complete', {});
    expect(sleepFn.mock.calls[1][0]).toBe(500);
  });

  it('R7. sleep called with retryDelayMs (500ms default) before attempt 2', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const wh = getWebhookStore().create('https://example.com/hook', ['scan.complete'], 'secret');
    await dispatchWebhook(wh, 'scan.complete', {});
    expect(sleepFn.mock.calls[2][0]).toBe(500);
  });
});

describe('WebhookStore unit', () => {
  beforeEach(() => resetWebhookStore());

  it('S1. resetWebhookStore clears all entries', () => {
    for (let i = 0; i < 3; i++) {
      getWebhookStore().create(`https://example.com/${i}`, ['scan.complete']);
    }
    resetWebhookStore();
    expect(getWebhookStore().list().length).toBe(0);
  });
});
