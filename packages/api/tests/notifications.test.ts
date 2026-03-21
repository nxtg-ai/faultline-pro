import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getNotificationStore,
  resetNotificationStore,
  notifyScanFailed,
  notifyProviderStatus,
  notifySubscriptionChanged,
  ALL_EVENT_TYPES,
} from '../src/store/notifications.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetNotificationStore();
  process.env.FAULTLINE_API_KEY = 'admin-secret';
  delete process.env.FAULTLINE_NOTIFY_WEBHOOK;
}

// ── NotificationStore unit tests ──────────────────────────────────────────────

describe('NotificationStore.prefs', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('getPrefs returns undefined for unknown key', () => {
    expect(getNotificationStore().getPrefs('no-such-key')).toBeUndefined();
  });

  it('setPrefs creates preferences', () => {
    const prefs = getNotificationStore().setPrefs('k1', ['scan.failed'], 'https://example.com/hook', null);
    expect(prefs.keyId).toBe('k1');
    expect(prefs.events).toContain('scan.failed');
    expect(prefs.webhookUrl).toBe('https://example.com/hook');
  });

  it('setPrefs upserts on second call', () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    getNotificationStore().setPrefs('k1', ['weekly.summary'], null, 'user@example.com');
    const prefs = getNotificationStore().getPrefs('k1');
    expect(prefs?.events).toContain('weekly.summary');
    expect(prefs?.events).not.toContain('scan.failed');
    expect(prefs?.email).toBe('user@example.com');
  });

  it('deletePrefs returns true and removes entry', () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    expect(getNotificationStore().deletePrefs('k1')).toBe(true);
    expect(getNotificationStore().getPrefs('k1')).toBeUndefined();
  });

  it('deletePrefs returns false for unknown key', () => {
    expect(getNotificationStore().deletePrefs('no-key')).toBe(false);
  });

  it('listPrefs returns all configured keys', () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    getNotificationStore().setPrefs('k2', ['weekly.summary'], null, null);
    expect(getNotificationStore().listPrefs()).toHaveLength(2);
  });
});

describe('NotificationStore.dispatch', () => {
  beforeEach(setup);

  it('dispatch with no subscribers is a no-op (no error)', async () => {
    await expect(getNotificationStore().dispatch('scan.failed', { error: 'test' })).resolves.not.toThrow();
  });

  it('dispatch records history with error=no-webhook-configured when no URL', async () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    await getNotificationStore().dispatch('scan.failed', { error: 'oops' }, 'k1');
    const history = getNotificationStore().getHistory('k1', 1);
    expect(history).toHaveLength(1);
    expect(history[0]?.delivered).toBe(false);
    expect(history[0]?.error).toBe('no-webhook-configured');
  });

  it('dispatch only delivers to subscribers of that event type', async () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    getNotificationStore().setPrefs('k2', ['weekly.summary'], null, null);
    await getNotificationStore().dispatch('scan.failed', { error: 'test' });
    expect(getNotificationStore().getHistory('k1', 10)).toHaveLength(1);
    expect(getNotificationStore().getHistory('k2', 10)).toHaveLength(0);
  });

  it('targetKeyId limits delivery to one key', async () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    getNotificationStore().setPrefs('k2', ['scan.failed'], null, null);
    await getNotificationStore().dispatch('scan.failed', { error: 'test' }, 'k1');
    expect(getNotificationStore().getHistory('k1', 10)).toHaveLength(1);
    expect(getNotificationStore().getHistory('k2', 10)).toHaveLength(0);
  });

  it('dispatch records eventType correctly', async () => {
    getNotificationStore().setPrefs('k1', ['provider.available'], null, null);
    await getNotificationStore().dispatch('provider.available', { provider: 'gemini' }, 'k1');
    const rec = getNotificationStore().getHistory('k1', 1)[0];
    expect(rec?.eventType).toBe('provider.available');
  });
});

describe('convenience dispatchers', () => {
  beforeEach(setup);

  it('notifyScanFailed dispatches to subscribed key', async () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    await notifyScanFailed('k1', 'All providers failed', 'gemini');
    const history = getNotificationStore().getHistory('k1');
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.eventType).toBe('scan.failed');
  });

  it('notifyProviderStatus dispatches provider.unavailable', async () => {
    getNotificationStore().setPrefs('k1', ['provider.unavailable'], null, null);
    await notifyProviderStatus('openai', false);
    // Broadcast — should reach k1
    expect(getNotificationStore().getHistory('k1').some(r => r.eventType === 'provider.unavailable')).toBe(true);
  });

  it('notifyProviderStatus dispatches provider.available', async () => {
    getNotificationStore().setPrefs('k1', ['provider.available'], null, null);
    await notifyProviderStatus('openai', true);
    expect(getNotificationStore().getHistory('k1').some(r => r.eventType === 'provider.available')).toBe(true);
  });

  it('notifySubscriptionChanged dispatches to specific key', async () => {
    getNotificationStore().setPrefs('k1', ['subscription.changed'], null, null);
    await notifySubscriptionChanged('k1', { oldTier: 'free', newTier: 'pro' });
    const rec = getNotificationStore().getHistory('k1', 1)[0];
    expect(rec?.eventType).toBe('subscription.changed');
  });
});

// ── ALL_EVENT_TYPES ───────────────────────────────────────────────────────────

describe('ALL_EVENT_TYPES', () => {
  it('contains 8 event types', () => {
    expect(ALL_EVENT_TYPES).toHaveLength(8);
  });

  it('includes expected events', () => {
    expect(ALL_EVENT_TYPES).toContain('scan.failed');
    expect(ALL_EVENT_TYPES).toContain('weekly.summary');
    expect(ALL_EVENT_TYPES).toContain('rate_limit.warning');
    expect(ALL_EVENT_TYPES).toContain('subscription.changed');
  });
});

// ── HTTP endpoints ────────────────────────────────────────────────────────────

describe('GET /notifications/events', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 (public — no auth)', async () => {
    const res = await server.inject({ method: 'GET', url: '/notifications/events' });
    expect(res.statusCode).toBe(200);
  });

  it('lists all 8 event types', async () => {
    const res = await server.inject({ method: 'GET', url: '/notifications/events' });
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.eventTypes)).toBe(true);
    expect(body.eventTypes).toHaveLength(8);
  });
});

describe('GET /notifications', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with text/html (public)', async () => {
    const res = await server.inject({ method: 'GET', url: '/notifications' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML mentions webhook delivery model', async () => {
    const res = await server.inject({ method: 'GET', url: '/notifications' });
    expect(res.body).toContain('webhook');
  });
});

describe('PUT /notifications/prefs/:keyId', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 401 without auth', async () => {
    const res = await server.inject({ method: 'PUT', url: '/notifications/prefs/k1', payload: JSON.stringify({ events: ['scan.failed'] }), headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(401);
  });

  it('creates prefs → 201', async () => {
    const res = await server.inject({
      method: 'PUT', url: '/notifications/prefs/k1',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ events: ['scan.failed', 'weekly.summary'], webhookUrl: 'https://example.com/hook' }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.keyId).toBe('k1');
    expect(body.events).toContain('scan.failed');
  });

  it('updates prefs → 200', async () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    const res = await server.inject({
      method: 'PUT', url: '/notifications/prefs/k1',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ events: ['weekly.summary'] }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 for invalid event type', async () => {
    const res = await server.inject({
      method: 'PUT', url: '/notifications/prefs/k1',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ events: ['not.a.real.event'] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for non-http webhookUrl', async () => {
    const res = await server.inject({
      method: 'PUT', url: '/notifications/prefs/k1',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ events: ['scan.failed'], webhookUrl: 'ftp://bad.url' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /notifications/prefs/:keyId', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 404 when no prefs exist', async () => {
    const res = await server.inject({ method: 'GET', url: '/notifications/prefs/k1', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with prefs when set', async () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], 'https://example.com', null);
    const res = await server.inject({ method: 'GET', url: '/notifications/prefs/k1', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).events).toContain('scan.failed');
  });
});

describe('DELETE /notifications/prefs/:keyId', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 204 on success', async () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    const res = await server.inject({ method: 'DELETE', url: '/notifications/prefs/k1', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(204);
  });

  it('returns 404 if no prefs', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/notifications/prefs/no-key', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /notifications/history', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 401 without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/notifications/history' });
    expect(res.statusCode).toBe(401);
  });

  it('returns empty records initially', async () => {
    const res = await server.inject({ method: 'GET', url: '/notifications/history', headers: { 'x-api-key': 'admin-secret' } });
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
    expect(body.records).toHaveLength(0);
  });

  it('returns records after dispatch', async () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    await getNotificationStore().dispatch('scan.failed', { error: 'oops' }, 'k1');
    const res = await server.inject({ method: 'GET', url: '/notifications/history', headers: { 'x-api-key': 'admin-secret' } });
    expect(JSON.parse(res.body).total).toBe(1);
  });
});

describe('POST /notifications/test/:keyId', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 404 if no prefs configured', async () => {
    const res = await server.inject({ method: 'POST', url: '/notifications/test/no-key', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with delivery result', async () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], null, null);
    const res = await server.inject({ method: 'POST', url: '/notifications/test/k1', headers: { 'x-api-key': 'admin-secret' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sent).toBe(true);
    expect(typeof body.delivered).toBe('boolean');
  });
});
