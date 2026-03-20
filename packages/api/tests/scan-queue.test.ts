import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getScanQueue,
  resetScanQueue,
  tierToPriority,
} from '../src/store/scan-queue.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetScanQueue();
  process.env.FAULTLINE_API_KEY = 'admin-secret';
}

// ── tierToPriority ────────────────────────────────────────────────────────────

describe('tierToPriority', () => {
  it('admin → 0', () => expect(tierToPriority('admin')).toBe(0));
  it('pro → 1',   () => expect(tierToPriority('pro')).toBe(1));
  it('free → 2',  () => expect(tierToPriority('free')).toBe(2));
});

// ── ScanQueue.enqueue ─────────────────────────────────────────────────────────

describe('ScanQueue.enqueue', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('returns item with required fields', () => {
    const item = getScanQueue().enqueue('key1', 2, 'hello', 'gemini');
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.keyId).toBe('key1');
    expect(item.priority).toBe(2);
    expect(item.text).toBe('hello');
    expect(item.provider).toBe('gemini');
    expect(item.status).toBe('pending');
    expect(item.createdAt).toBeDefined();
  });

  it('item is retrievable via get()', () => {
    const item = getScanQueue().enqueue('key1', 2, 'hello', 'gemini');
    expect(getScanQueue().get(item.id)).toBeDefined();
    expect(getScanQueue().get(item.id)?.id).toBe(item.id);
  });

  it('appears in stats as pending', () => {
    getScanQueue().enqueue('key1', 2, 'text', 'gemini');
    const stats = getScanQueue().getStats();
    expect(stats.pending).toBe(1);
    expect(stats.total).toBe(1);
  });
});

// ── ScanQueue.cancel ──────────────────────────────────────────────────────────

describe('ScanQueue.cancel', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('returns true and sets status=cancelled for pending item', () => {
    const item = getScanQueue().enqueue('key1', 2, 'text', 'gemini');
    expect(getScanQueue().cancel(item.id)).toBe(true);
    expect(getScanQueue().get(item.id)?.status).toBe('cancelled');
  });

  it('removes item from pending queue', () => {
    const item = getScanQueue().enqueue('key1', 2, 'text', 'gemini');
    getScanQueue().cancel(item.id);
    expect(getScanQueue().getStats().pending).toBe(0);
    expect(getScanQueue().getStats().cancelled).toBe(1);
  });

  it('returns false for unknown id', () => {
    expect(getScanQueue().cancel('no-such-id')).toBe(false);
  });
});

// ── ScanQueue.getPosition ─────────────────────────────────────────────────────

describe('ScanQueue.getPosition', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('first enqueued item is position 1', () => {
    const item = getScanQueue().enqueue('key1', 2, 'text', 'gemini');
    expect(getScanQueue().getPosition(item.id)).toBe(1);
  });

  it('admin item jumps ahead of free-tier items', () => {
    const free1 = getScanQueue().enqueue('free-key', 2, 'text', 'gemini');
    const free2 = getScanQueue().enqueue('free-key', 2, 'text', 'gemini');
    const admin = getScanQueue().enqueue('admin', 0, 'text', 'gemini');
    expect(getScanQueue().getPosition(admin.id)).toBe(1);
    expect(getScanQueue().getPosition(free1.id)).toBe(2);
    expect(getScanQueue().getPosition(free2.id)).toBe(3);
  });

  it('pro item sits between admin and free', () => {
    const free = getScanQueue().enqueue('free-key', 2, 'text', 'gemini');
    const pro  = getScanQueue().enqueue('pro-key',  1, 'text', 'gemini');
    expect(getScanQueue().getPosition(pro.id)).toBe(1);
    expect(getScanQueue().getPosition(free.id)).toBe(2);
  });

  it('returns -1 for non-pending item', () => {
    const item = getScanQueue().enqueue('key1', 2, 'text', 'gemini');
    getScanQueue().cancel(item.id);
    expect(getScanQueue().getPosition(item.id)).toBe(-1);
  });
});

// ── ScanQueue.list ────────────────────────────────────────────────────────────

describe('ScanQueue.list', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('returns items for the given keyId', () => {
    getScanQueue().enqueue('key1', 2, 'text', 'gemini');
    getScanQueue().enqueue('key1', 2, 'text', 'gemini');
    getScanQueue().enqueue('key2', 2, 'text', 'gemini');
    const items = getScanQueue().list('key1');
    expect(items).toHaveLength(2);
    expect(items.every(i => i.keyId === 'key1')).toBe(true);
  });

  it('without keyId returns all items', () => {
    getScanQueue().enqueue('key1', 2, 'text', 'gemini');
    getScanQueue().enqueue('key2', 2, 'text', 'gemini');
    expect(getScanQueue().list()).toHaveLength(2);
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) getScanQueue().enqueue('key1', 2, 'text', 'gemini');
    expect(getScanQueue().list('key1', 3)).toHaveLength(3);
  });
});

// ── ScanQueue.getStats ────────────────────────────────────────────────────────

describe('ScanQueue.getStats', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('all zeros on empty queue', () => {
    const stats = getScanQueue().getStats();
    expect(stats.pending).toBe(0);
    expect(stats.processing).toBe(0);
    expect(stats.completed).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.cancelled).toBe(0);
    expect(stats.total).toBe(0);
  });

  it('counts cancelled correctly', () => {
    const item = getScanQueue().enqueue('key1', 2, 'text', 'gemini');
    getScanQueue().cancel(item.id);
    const stats = getScanQueue().getStats();
    expect(stats.cancelled).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.total).toBe(1);
  });
});

// ── HTTP: GET /queue/status ───────────────────────────────────────────────────

describe('GET /queue/status', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/queue/status' });
    expect(res.statusCode).toBe(200);
  });

  it('includes expected stat fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/queue/status' });
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('pending');
    expect(body).toHaveProperty('processing');
    expect(body).toHaveProperty('completed');
    expect(body).toHaveProperty('failed');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('maxConcurrency');
    expect(body).toHaveProperty('priorityLevels');
  });

  it('priorityLevels has 3 entries', async () => {
    const res = await server.inject({ method: 'GET', url: '/queue/status' });
    expect(JSON.parse(res.body).priorityLevels).toHaveLength(3);
  });
});

// ── HTTP: GET /queue (HTML) ───────────────────────────────────────────────────

describe('GET /queue', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with HTML content-type', async () => {
    const res = await server.inject({ method: 'GET', url: '/queue' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML contains Scan Queue heading', async () => {
    const res = await server.inject({ method: 'GET', url: '/queue' });
    expect(res.body).toContain('Scan Queue');
  });
});

// ── HTTP: POST /queue/scans ───────────────────────────────────────────────────

describe('POST /queue/scans', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 4xx without auth', async () => {
    const res = await server.inject({
      method: 'POST', url: '/queue/scans',
      payload: { text: 'hello world' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('returns 202 with id and pollUrl', async () => {
    const res = await server.inject({
      method: 'POST', url: '/queue/scans',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { text: 'hello world' },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('pollUrl');
    expect(body.pollUrl).toContain(body.id);
    expect(body.status).toBe('pending');
  });

  it('returns 400 when text is missing', async () => {
    const res = await server.inject({
      method: 'POST', url: '/queue/scans',
      headers: { 'x-api-key': 'admin-secret' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when text is empty string', async () => {
    const res = await server.inject({
      method: 'POST', url: '/queue/scans',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { text: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('item appears in queue stats', async () => {
    await server.inject({
      method: 'POST', url: '/queue/scans',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { text: 'hello world' },
    });
    const statsRes = await server.inject({ method: 'GET', url: '/queue/status' });
    const stats = JSON.parse(statsRes.body);
    expect(stats.total).toBeGreaterThanOrEqual(1);
  });
});

// ── HTTP: GET /queue/scans/:id ────────────────────────────────────────────────

describe('GET /queue/scans/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'GET', url: '/queue/scans/no-such-id',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns item with position for pending item', async () => {
    const enqRes = await server.inject({
      method: 'POST', url: '/queue/scans',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { text: 'hello world' },
    });
    const { id } = JSON.parse(enqRes.body);
    const res = await server.inject({
      method: 'GET', url: `/queue/scans/${id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(id);
    expect(body.status).toBe('pending');
    expect(body.position).toBeGreaterThanOrEqual(1);
  });

  it('returns 4xx without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/queue/scans/some-id' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ── HTTP: GET /queue/scans ────────────────────────────────────────────────────

describe('GET /queue/scans', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns items list for authenticated key', async () => {
    await server.inject({
      method: 'POST', url: '/queue/scans',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { text: 'hello world' },
    });
    const res = await server.inject({
      method: 'GET', url: '/queue/scans',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('total');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('returns 4xx without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/queue/scans' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ── HTTP: DELETE /queue/scans/:id ─────────────────────────────────────────────

describe('DELETE /queue/scans/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'DELETE', url: '/queue/scans/no-such-id',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 204 for pending item', async () => {
    const enqRes = await server.inject({
      method: 'POST', url: '/queue/scans',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { text: 'hello world' },
    });
    const { id } = JSON.parse(enqRes.body);
    const res = await server.inject({
      method: 'DELETE', url: `/queue/scans/${id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('item is cancelled after delete', async () => {
    const enqRes = await server.inject({
      method: 'POST', url: '/queue/scans',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { text: 'hello world' },
    });
    const { id } = JSON.parse(enqRes.body);
    await server.inject({
      method: 'DELETE', url: `/queue/scans/${id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    const getRes = await server.inject({
      method: 'GET', url: `/queue/scans/${id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(JSON.parse(getRes.body).status).toBe('cancelled');
  });

  it('returns 409 for already-cancelled item', async () => {
    const enqRes = await server.inject({
      method: 'POST', url: '/queue/scans',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { text: 'hello world' },
    });
    const { id } = JSON.parse(enqRes.body);
    await server.inject({
      method: 'DELETE', url: `/queue/scans/${id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    const res = await server.inject({
      method: 'DELETE', url: `/queue/scans/${id}`,
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(409);
  });
});
