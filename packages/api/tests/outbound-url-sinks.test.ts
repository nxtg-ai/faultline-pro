/**
 * Outbound URL guard at every sink (CodeQL #5, SSRF).
 *
 * Registration routes must answer 400 for a private target, and every send path
 * must re-check at send time (DNS can change after registration) without calling
 * fetch. The redirect and read-back tests use real loopback servers with the
 * test-only override on, because a mocked fetch cannot prove undici's
 * redirect: 'manual' behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { resetOutboundResolver, setOutboundResolver, type ResolvedAddress } from '../src/lib/outbound-url.js';
import {
  dispatchWebhook,
  getWebhookDeliveryLog,
  getWebhookStore,
  resetWebhookCircuitBreaker,
  resetWebhookDeliveryLog,
  resetWebhookRateLimiter,
  resetWebhookStore,
  resetWebhookTestHistory,
  sendTestWebhook,
  _setSleepFn,
} from '../src/store/webhooks.js';
import { getJobScheduler, getJobStore, resetJobScheduler, resetJobStore } from '../src/store/jobs.js';
import { getNotificationStore, resetNotificationStore } from '../src/store/notifications.js';
import { getRateLimitAlertStore, resetRateLimitAlertStore } from '../src/store/rate-alerts.js';
import { resetKeyStore } from '../src/store/keys.js';
import { makeWebhook } from './helpers/make-webhook.js';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn().mockResolvedValue({ overallRisk: 'low', claims: [], verifications: {} }),
}));

const ADMIN = 'admin-secret';
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/';
const JSON_HEADERS = { 'x-api-key': ADMIN, 'content-type': 'application/json' };

let fetchSpy: ReturnType<typeof vi.fn>;

/** Every hostname resolves to the given address. */
function resolveAllTo(address: string): void {
  setOutboundResolver(async (): Promise<ResolvedAddress[]> => [{ address, family: address.includes(':') ? 6 : 4 }]);
}

function guardOn(): void {
  vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '');
  resolveAllTo('93.184.216.34');
  fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
}

function resetStores(): void {
  process.env.FAULTLINE_API_KEY = ADMIN;
  resetKeyStore();
  resetWebhookStore();
  resetWebhookTestHistory();
  resetWebhookDeliveryLog();
  resetWebhookCircuitBreaker();
  resetWebhookRateLimiter();
  resetJobStore();
  resetJobScheduler();
  resetNotificationStore();
  resetRateLimitAlertStore();
  _setSleepFn(() => Promise.resolve());
}

function cleanUp(): void {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetOutboundResolver();
  delete process.env.FAULTLINE_API_KEY;
}

// ── Registration time: 400 with the guard's message, fetch never called ──────

describe('registration routes refuse private targets', () => {
  let server: FastifyInstance;
  beforeEach(() => { resetStores(); guardOn(); server = buildServer(); });
  afterEach(async () => { await server.close(); cleanUp(); });

  it('POST /webhooks/test to the metadata address → 400, fetch never called', async () => {
    const res = await server.inject({ method: 'POST', url: '/webhooks/test', headers: JSON_HEADERS, payload: { url: METADATA_URL } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Outbound URL blocked: .*169\.254\.169\.254/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POST /webhooks/test to a name that resolves into the Fly private network → 400', async () => {
    resolveAllTo('fdaa:0:1:a7b:1::2');
    const res = await server.inject({ method: 'POST', url: '/webhooks/test', headers: JSON_HEADERS, payload: { url: 'https://evil.example.com/' } });
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POST /webhooks/test to a public host → 200 and one fetch with redirect: manual', async () => {
    const res = await server.inject({ method: 'POST', url: '/webhooks/test', headers: JSON_HEADERS, payload: { url: 'https://hooks.example.com/x' } });
    expect(res.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].redirect).toBe('manual');
  });

  it('POST /webhooks with a localhost URL → 400 and nothing stored', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks', headers: JSON_HEADERS,
      payload: { url: 'http://localhost:3000/admin', events: ['scan.complete'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/private or internal name/);
    expect(getWebhookStore().list()).toHaveLength(0);
  });

  it('POST /webhooks with a public URL → 201 (the guard does not over-block)', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks', headers: JSON_HEADERS,
      payload: { url: 'https://hooks.example.com/x', events: ['scan.complete'] },
    });
    expect(res.statusCode).toBe(201);
    expect(getWebhookStore().list()).toHaveLength(1);
  });

  it('POST /jobs with a private webhookUrl → 400 and no job created', async () => {
    const res = await server.inject({
      method: 'POST', url: '/jobs', headers: JSON_HEADERS,
      payload: { text: 'claim', schedule: 'every 1h', webhookUrl: 'http://10.0.0.5/hook' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^Outbound URL blocked/);
    expect(getJobStore().list()).toHaveLength(0);
  });

  it('PUT /notifications/prefs/:keyId with a *.internal webhookUrl → 400 and no prefs stored', async () => {
    const res = await server.inject({
      method: 'PUT', url: '/notifications/prefs/admin', headers: JSON_HEADERS,
      payload: { events: ['scan.failed'], webhookUrl: 'http://faultline-api.internal:3000/' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/private or internal name/);
    expect(getNotificationStore().getPrefs('admin')).toBeUndefined();
  });
});

// ── Send time: DNS now resolves private → no fetch ────────────────────────────

describe('send paths re-check at send time', () => {
  beforeEach(() => { resetStores(); guardOn(); });
  afterEach(cleanUp);

  it('dispatchWebhook: a registered host that now resolves private is not fetched, and is not retried', async () => {
    const webhook = makeWebhook({ url: 'https://was-public.example.com/hook', maxAttempts: 3 });
    resolveAllTo('127.0.0.1');
    await dispatchWebhook(webhook, 'scan.complete', { ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    const log = getWebhookDeliveryLog().list(webhook.id);
    expect(log).toHaveLength(1);
    expect(log[0]?.delivered).toBe(false);
    expect(log[0]?.error).toMatch(/^Outbound URL blocked/);
  });

  it('dispatchWebhook: a public host is fetched once with redirect: manual', async () => {
    const webhook = makeWebhook({ url: 'https://hooks.example.com/hook' });
    await dispatchWebhook(webhook, 'scan.complete', { ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].redirect).toBe('manual');
  });

  it('POST /webhooks/test/:id: a registered host that now resolves private returns the refusal, no fetch', async () => {
    const webhook = getWebhookStore().create('https://was-public.example.com/hook', ['scan.complete']);
    resolveAllTo('169.254.169.254');
    const server = buildServer();
    try {
      const res = await server.inject({ method: 'POST', url: `/webhooks/test/${webhook.id}`, headers: JSON_HEADERS, payload: {} });
      expect(res.statusCode).toBe(200);
      expect(res.json().delivered).toBe(false);
      expect(res.json().error).toMatch(/^Outbound URL blocked/);
    } finally {
      await server.close();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('job scheduler: a job webhookUrl that now resolves private is not fetched', async () => {
    const job = getJobStore().create({ text: 'claim', schedule: 'every 1h', webhookUrl: 'https://was-public.example.com/job' });
    resolveAllTo('10.1.2.3');
    await getJobScheduler().triggerJob(job.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(getJobStore().get(job.id)?.runCount).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('job scheduler: a public job webhookUrl is fetched with redirect: manual', async () => {
    const job = getJobStore().create({ text: 'claim', schedule: 'every 1h', webhookUrl: 'https://hooks.example.com/job' });
    await getJobScheduler().triggerJob(job.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[1].redirect).toBe('manual');
  });

  it('notifications: a per-key webhookUrl that now resolves private records the refusal, no fetch', async () => {
    getNotificationStore().setPrefs('key-1', ['scan.failed'], 'https://was-public.example.com/n', null);
    resolveAllTo('192.168.0.10');
    await getNotificationStore().dispatch('scan.failed', { error: 'x' }, 'key-1');
    const history = getNotificationStore().getHistory('key-1');
    expect(history).toHaveLength(1);
    expect(history[0]?.delivered).toBe(false);
    expect(history[0]?.error).toMatch(/^Outbound URL blocked/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('notifications: FAULTLINE_NOTIFY_WEBHOOK pointing at the metadata address is refused, no fetch', async () => {
    vi.stubEnv('FAULTLINE_NOTIFY_WEBHOOK', METADATA_URL);
    await getNotificationStore().dispatch('provider.unavailable', { provider: 'openai' });
    const history = getNotificationStore().getHistory('*');
    expect(history).toHaveLength(1);
    expect(history[0]?.error).toMatch(/^Outbound URL blocked/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rate alerts: FAULTLINE_ALERT_WEBHOOK pointing at loopback is refused, no fetch', async () => {
    vi.stubEnv('FAULTLINE_ALERT_WEBHOOK', 'http://127.0.0.1:3000/internal');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await getRateLimitAlertStore().fire('key-1', 9, 10);
    warn.mockRestore();
    const alerts = getRateLimitAlertStore().getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.delivered).toBe(false);
    expect(alerts[0]?.deliveryNote).toMatch(/^error: Outbound URL blocked/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sendTestWebhook called directly still refuses a private URL without fetching', async () => {
    const result = await sendTestWebhook(METADATA_URL, 'scan.complete', null);
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/^Outbound URL blocked/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Real sockets: redirects are not followed, the body is not read back ───────

interface LoopbackPair {
  redirector: Server;
  target: Server;
  targetHits: number;
  redirectorUrl: string;
  secretUrl: string;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

async function startLoopbackPair(): Promise<LoopbackPair> {
  const pair = { targetHits: 0 } as LoopbackPair;
  pair.target = createServer((_req, res) => { pair.targetHits++; res.end('INTERNAL-ONLY'); });
  const targetBase = await listen(pair.target);
  pair.redirector = createServer((req, res) => {
    if (req.url === '/secret') {
      res.setHeader('x-internal-token', 'tok-123');
      res.end('SECRET-BODY');
      return;
    }
    res.writeHead(302, { location: `${targetBase}/landed` });
    res.end();
  });
  const redirectorBase = await listen(pair.redirector);
  pair.redirectorUrl = `${redirectorBase}/hook`;
  pair.secretUrl = `${redirectorBase}/secret`;
  return pair;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('real loopback servers (override on: loopback allowed)', () => {
  let pair: LoopbackPair;
  beforeEach(async () => {
    resetStores();
    vi.stubEnv('FAULTLINE_OUTBOUND_ALLOW_PRIVATE', '1');
    pair = await startLoopbackPair();
  });
  afterEach(async () => {
    await close(pair.redirector);
    await close(pair.target);
    cleanUp();
  });

  it('sendTestWebhook records a 302 as the status and never requests the Location', async () => {
    const result = await sendTestWebhook(pair.redirectorUrl, 'scan.complete', null);
    expect(result.error).toBeNull();
    expect(result.statusCode).toBe(302);
    expect(result.delivered).toBe(false);
    expect(pair.targetHits).toBe(0);
  });

  it('dispatchWebhook records a 302 as the status and never requests the Location', async () => {
    const webhook = makeWebhook({ url: pair.redirectorUrl, maxAttempts: 1 });
    await dispatchWebhook(webhook, 'scan.complete', { ok: true });
    const log = getWebhookDeliveryLog().list(webhook.id);
    expect(log).toHaveLength(1);
    expect(log[0]?.statusCode).toBe(302);
    expect(log[0]?.delivered).toBe(false);
    expect(pair.targetHits).toBe(0);
  });

  it('POST /webhooks/test returns status only: no target body, no target headers', async () => {
    process.env.FAULTLINE_API_KEY = ADMIN;
    const server = buildServer();
    try {
      const res = await server.inject({ method: 'POST', url: '/webhooks/test', headers: JSON_HEADERS, payload: { url: pair.secretUrl } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.statusCode).toBe(200);
      expect(body.statusText).toBe('OK');
      expect(body.delivered).toBe(true);
      expect(body.responseBody).toBeNull();
      expect(body.responseHeaders).toEqual({});
      expect(res.body).not.toContain('SECRET-BODY');
      expect(res.body).not.toContain('tok-123');
    } finally {
      await server.close();
    }
  });
});
