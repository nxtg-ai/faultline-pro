import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getWebhookStore,
  resetWebhookStore,
  getWebhookTestHistory,
  resetWebhookTestHistory,
  sendTestWebhook,
  SAMPLE_PAYLOADS,
} from '../src/store/webhooks.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetWebhookStore();
  resetWebhookTestHistory();
  process.env.FAULTLINE_API_KEY = 'admin-secret';
}

// ── SAMPLE_PAYLOADS ───────────────────────────────────────────────────────────

describe('SAMPLE_PAYLOADS', () => {
  it('has scan.complete payload', () => {
    expect(SAMPLE_PAYLOADS['scan.complete']).toBeDefined();
  });
  it('has scan.failed payload', () => {
    expect(SAMPLE_PAYLOADS['scan.failed']).toBeDefined();
  });
  it('has job.complete payload', () => {
    expect(SAMPLE_PAYLOADS['job.complete']).toBeDefined();
  });
  it('has claim.verdict_changed payload', () => {
    expect(SAMPLE_PAYLOADS['claim.verdict_changed']).toBeDefined();
  });
  it('has 6 event types', () => {
    expect(Object.keys(SAMPLE_PAYLOADS)).toHaveLength(6);
  });
});

// ── sendTestWebhook ───────────────────────────────────────────────────────────

describe('sendTestWebhook', () => {
  beforeEach(setup);

  it('records result in test history', async () => {
    // Use a guaranteed-fail URL to test without a real server
    await sendTestWebhook('http://127.0.0.1:1', 'scan.complete', null);
    expect(getWebhookTestHistory().list()).toHaveLength(1);
  });

  it('result has required fields', async () => {
    const result = await sendTestWebhook('http://127.0.0.1:1', 'scan.failed', null);
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('event');
    expect(result).toHaveProperty('sentAt');
    expect(result).toHaveProperty('latencyMs');
    expect(result).toHaveProperty('delivered');
    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty('signatureHeader');
  });

  it('delivered=false and error set on connection refused', async () => {
    const result = await sendTestWebhook('http://127.0.0.1:1', 'scan.complete', null);
    expect(result.delivered).toBe(false);
    expect(result.error).not.toBeNull();
  });

  it('signatureHeader is null when no secret provided', async () => {
    const result = await sendTestWebhook('http://127.0.0.1:1', 'scan.complete', null);
    expect(result.signatureHeader).toBeNull();
  });

  it('signatureHeader is set when secret provided', async () => {
    const result = await sendTestWebhook('http://127.0.0.1:1', 'scan.complete', 'my-secret');
    expect(result.signatureHeader).toMatch(/^sha256=/);
  });

  it('webhookId prefix appears in result.id', async () => {
    const result = await sendTestWebhook('http://127.0.0.1:1', 'scan.complete', null, 'hook-123');
    expect(result.id).toMatch(/^hook-123:/);
  });

  it('history list filtered by webhookId prefix', async () => {
    await sendTestWebhook('http://127.0.0.1:1', 'scan.complete', null, 'hook-A');
    await sendTestWebhook('http://127.0.0.1:1', 'scan.complete', null, 'hook-B');
    expect(getWebhookTestHistory().list('hook-A')).toHaveLength(1);
    expect(getWebhookTestHistory().list('hook-B')).toHaveLength(1);
    expect(getWebhookTestHistory().list()).toHaveLength(2);
  });

  it('history newest first', async () => {
    const r1 = await sendTestWebhook('http://127.0.0.1:1', 'scan.complete', null);
    const r2 = await sendTestWebhook('http://127.0.0.1:1', 'scan.failed', null);
    const list = getWebhookTestHistory().list();
    expect(list[0]?.id).toBe(r2.id);
    expect(list[1]?.id).toBe(r1.id);
  });
});

// ── WebhookStore.getById ──────────────────────────────────────────────────────

describe('WebhookStore.getById', () => {
  beforeEach(setup);

  it('returns webhook by id', () => {
    const wh = getWebhookStore().create('https://example.com', ['scan.complete']);
    expect(getWebhookStore().getById(wh.id)?.id).toBe(wh.id);
  });

  it('returns undefined for unknown id', () => {
    expect(getWebhookStore().getById('no-such')).toBeUndefined();
  });
});

// ── HTTP: GET /webhooks/test ──────────────────────────────────────────────────

describe('GET /webhooks/test', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with text/html (public — no auth)', async () => {
    const res = await server.inject({ method: 'GET', url: '/webhooks/test' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML includes send button', async () => {
    const res = await server.inject({ method: 'GET', url: '/webhooks/test' });
    expect(res.body).toContain('Send Test Payload');
  });

  it('HTML lists /webhooks/test endpoint', async () => {
    const res = await server.inject({ method: 'GET', url: '/webhooks/test' });
    expect(res.body).toContain('/webhooks/test');
  });

  it('HTML includes event type options', async () => {
    const res = await server.inject({ method: 'GET', url: '/webhooks/test' });
    expect(res.body).toContain('scan.complete');
    expect(res.body).toContain('scan.failed');
  });
});

// ── HTTP: POST /webhooks/test ─────────────────────────────────────────────────

describe('POST /webhooks/test', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 401 without auth', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks/test',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'http://127.0.0.1:1' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for invalid URL', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks/test',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'not-a-url' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with test result (even on delivery failure)', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks/test',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'http://127.0.0.1:1', event: 'scan.complete' }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('delivered');
    expect(body).toHaveProperty('latencyMs');
    expect(body.event).toBe('scan.complete');
  });

  it('result has url and event echoed back', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks/test',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'http://127.0.0.1:1', event: 'scan.failed' }),
    });
    const body = JSON.parse(res.body);
    expect(body.url).toBe('http://127.0.0.1:1');
    expect(body.event).toBe('scan.failed');
  });
});

// ── HTTP: POST /webhooks/test/:id ─────────────────────────────────────────────

describe('POST /webhooks/test/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 404 for unknown webhook id', async () => {
    const res = await server.inject({
      method: 'POST', url: '/webhooks/test/no-such-id',
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 for registered webhook', async () => {
    const wh = getWebhookStore().create('http://127.0.0.1:1', ['scan.complete']);
    const res = await server.inject({
      method: 'POST', url: `/webhooks/test/${wh.id}`,
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.url).toBe('http://127.0.0.1:1');
    expect(body.event).toBe('scan.complete');
  });

  it('uses overridden event type when provided', async () => {
    const wh = getWebhookStore().create('http://127.0.0.1:1', ['scan.complete']);
    const res = await server.inject({
      method: 'POST', url: `/webhooks/test/${wh.id}`,
      headers: { 'x-api-key': 'admin-secret', 'content-type': 'application/json' },
      payload: JSON.stringify({ event: 'scan.failed' }),
    });
    expect(JSON.parse(res.body).event).toBe('scan.failed');
  });
});

// ── HTTP: GET /webhooks/test/history ─────────────────────────────────────────

describe('GET /webhooks/test/history', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 401 without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/webhooks/test/history' });
    expect(res.statusCode).toBe(401);
  });

  it('returns empty records initially', async () => {
    const res = await server.inject({ method: 'GET', url: '/webhooks/test/history', headers: { 'x-api-key': 'admin-secret' } });
    const body = JSON.parse(res.body);
    expect(body.total).toBe(0);
  });

  it('returns records after test send', async () => {
    await sendTestWebhook('http://127.0.0.1:1', 'scan.complete', null);
    const res = await server.inject({ method: 'GET', url: '/webhooks/test/history', headers: { 'x-api-key': 'admin-secret' } });
    expect(JSON.parse(res.body).total).toBe(1);
  });
});
