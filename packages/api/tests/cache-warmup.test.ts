/**
 * Tests for Cache Warmup system (D-164)
 *
 * Covers:
 *   WarmupStore — create, list, get, update, delete, recordRun, getSummary
 *   CacheWarmer — warmOne (mocked), warmAll
 *   HTTP routes — POST /cache/warmup, GET /cache/warmup/summary, POST /cache/warmup/run,
 *                  GET /cache/warmup, GET /cache/warmup/suggestions,
 *                  GET /cache/warmup/:id, PATCH /cache/warmup/:id,
 *                  DELETE /cache/warmup/:id, POST /cache/warmup/:id/run,
 *                  GET /cache/warmup/:id/history
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getWarmupStore,
  resetWarmupStore,
  getCacheWarmer,
  resetCacheWarmer,
  type WarmupTarget,
} from '../src/store/cache-warmup.js';
import type { FastifyInstance } from 'fastify';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ADMIN_KEY = 'admin-key';
const ADMIN_HEADERS = { 'x-api-key': ADMIN_KEY };

function setup() {
  resetWarmupStore();
  resetCacheWarmer();
  process.env.FAULTLINE_API_KEY = ADMIN_KEY;
  process.env.ADMIN_API_KEY     = ADMIN_KEY;
}

function createTarget(overrides: Partial<{
  name: string; text: string; provider: string; priority: number; enabled: boolean;
}> = {}): WarmupTarget {
  return getWarmupStore().create(
    {
      name:     overrides.name     ?? 'Test Target',
      text:     overrides.text     ?? 'Revenue grew 45% in 2024.',
      provider: (overrides.provider as 'gemini') ?? 'gemini',
      priority: overrides.priority ?? 100,
      enabled:  overrides.enabled  ?? true,
    },
    'admin',
  );
}

// ── WarmupStore unit tests ────────────────────────────────────────────────────

describe('WarmupStore', () => {
  beforeEach(setup);

  it('creates a target and returns it', () => {
    const t = createTarget();
    expect(t.id).toBeTruthy();
    expect(t.name).toBe('Test Target');
    expect(t.provider).toBe('gemini');
    expect(t.enabled).toBe(true);
    expect(t.priority).toBe(100);
    expect(t.runCount).toBe(0);
    expect(t.history).toHaveLength(0);
    expect(t.lastWarmAt).toBeNull();
  });

  it('defaults provider to gemini', () => {
    const t = getWarmupStore().create({ name: 'No provider', text: 'Some text' }, 'admin');
    expect(t.provider).toBe('gemini');
  });

  it('deduplicates by text + provider', () => {
    createTarget({ text: 'Dup text', provider: 'gemini' });
    expect(() => createTarget({ name: 'Dup 2', text: 'Dup text', provider: 'gemini' })).toThrow(
      'already exists',
    );
  });

  it('allows same text with different provider', () => {
    createTarget({ text: 'Same text', provider: 'gemini' });
    const t2 = getWarmupStore().create(
      { name: 'Other prov', text: 'Same text', provider: 'openai' },
      'admin',
    );
    expect(t2.provider).toBe('openai');
  });

  it('get returns the target by id', () => {
    const t = createTarget();
    expect(getWarmupStore().get(t.id)?.id).toBe(t.id);
  });

  it('get returns undefined for unknown id', () => {
    expect(getWarmupStore().get('no-such-id')).toBeUndefined();
  });

  it('list returns targets sorted by priority', () => {
    createTarget({ name: 'B', text: 'text b', priority: 50 });
    createTarget({ name: 'C', text: 'text c', priority: 200 });
    createTarget({ name: 'A', text: 'text a', priority: 10 });
    const list = getWarmupStore().list();
    expect(list[0].priority).toBe(10);
    expect(list[1].priority).toBe(50);
    expect(list[2].priority).toBe(200);
  });

  it('list(true) returns only enabled targets', () => {
    createTarget({ name: 'Enabled', text: 'text-en', enabled: true });
    createTarget({ name: 'Disabled', text: 'text-dis', enabled: false });
    const enabled = getWarmupStore().list(true);
    expect(enabled.every(t => t.enabled)).toBe(true);
    expect(enabled.length).toBe(1);
  });

  it('update modifies fields', () => {
    const t = createTarget();
    const updated = getWarmupStore().update(t.id, { name: 'New Name', enabled: false, priority: 5 });
    expect(updated?.name).toBe('New Name');
    expect(updated?.enabled).toBe(false);
    expect(updated?.priority).toBe(5);
  });

  it('update returns null for unknown id', () => {
    expect(getWarmupStore().update('no-such', { name: 'X' })).toBeNull();
  });

  it('delete removes the target', () => {
    const t = createTarget();
    expect(getWarmupStore().delete(t.id)).toBe(true);
    expect(getWarmupStore().get(t.id)).toBeUndefined();
  });

  it('delete returns false for unknown id', () => {
    expect(getWarmupStore().delete('no-such')).toBe(false);
  });

  it('recordRun appends to history and updates lastWarmAt', () => {
    const t = createTarget();
    const run = getWarmupStore().recordRun(t.id, {
      startedAt:   new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs:  120,
      status:      'done',
    });
    expect(run.runId).toBeTruthy();
    expect(run.status).toBe('done');
    const updated = getWarmupStore().get(t.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastStatus).toBe('done');
    expect(updated.lastWarmAt).toBeTruthy();
    expect(updated.history).toHaveLength(1);
  });

  it('recordRun caps history at 20', () => {
    const t = createTarget();
    for (let i = 0; i < 25; i++) {
      getWarmupStore().recordRun(t.id, {
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: i,
        status: 'done',
      });
    }
    expect(getWarmupStore().get(t.id)!.history).toHaveLength(20);
  });

  it('getSummary counts totals', () => {
    createTarget({ name: 'A', text: 'text-a', enabled: true });
    createTarget({ name: 'B', text: 'text-b', enabled: false });
    const s = getWarmupStore().getSummary();
    expect(s.total).toBe(2);
    expect(s.enabled).toBe(1);
    expect(s.lastRun).toBeNull();
    expect(s.successCount).toBe(0);
    expect(s.errorCount).toBe(0);
  });

  it('getSummary tracks successCount and errorCount', () => {
    const t = createTarget();
    getWarmupStore().recordRun(t.id, {
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      durationMs: 10, status: 'done',
    });
    getWarmupStore().recordRun(t.id, {
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      durationMs: 10, status: 'error', error: 'oops',
    });
    const s = getWarmupStore().getSummary();
    expect(s.successCount).toBe(1);
    expect(s.errorCount).toBe(1);
    expect(s.lastRun).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── HTTP routes ───────────────────────────────────────────────────────────────

describe('POST /cache/warmup', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; delete process.env.ADMIN_API_KEY; });

  it('returns 401 without auth', async () => {
    const res = await server.inject({ method: 'POST', url: '/cache/warmup',
      body: { name: 'Test', text: 'Some text' } });
    expect(res.statusCode).toBe(403);
  });

  it('creates a target and returns 201', async () => {
    const res = await server.inject({
      method: 'POST', url: '/cache/warmup',
      headers: ADMIN_HEADERS,
      body: { name: 'Test Target', text: 'Revenue grew 45%.', provider: 'gemini' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('Test Target');
    expect(body.provider).toBe('gemini');
  });

  it('returns 400 on duplicate text+provider', async () => {
    const payload = { name: 'T1', text: 'Dup text 123', provider: 'gemini' };
    await server.inject({ method: 'POST', url: '/cache/warmup', headers: ADMIN_HEADERS, body: payload });
    const res2 = await server.inject({ method: 'POST', url: '/cache/warmup', headers: ADMIN_HEADERS, body: { ...payload, name: 'T2' } });
    expect(res2.statusCode).toBe(400);
  });

  it('returns 400 on missing required fields', async () => {
    const res = await server.inject({ method: 'POST', url: '/cache/warmup',
      headers: ADMIN_HEADERS, body: { name: 'No text' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /cache/warmup', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; delete process.env.ADMIN_API_KEY; });

  it('lists all targets', async () => {
    createTarget({ name: 'A', text: 'text-a' });
    createTarget({ name: 'B', text: 'text-b' });
    const res = await server.inject({ method: 'GET', url: '/cache/warmup', headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.targets).toHaveLength(2);
  });

  it('filters by enabled=true', async () => {
    createTarget({ name: 'Enabled', text: 'text-en', enabled: true });
    createTarget({ name: 'Disabled', text: 'text-dis', enabled: false });
    const res = await server.inject({ method: 'GET', url: '/cache/warmup?enabled=true', headers: ADMIN_HEADERS });
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    expect(body.targets[0].name).toBe('Enabled');
  });

  it('returns 401 without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/cache/warmup' });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /cache/warmup/summary', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; delete process.env.ADMIN_API_KEY; });

  it('returns summary shape', async () => {
    const res = await server.inject({ method: 'GET', url: '/cache/warmup/summary', headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.total).toBe('number');
    expect(typeof body.enabled).toBe('number');
    expect(typeof body.successCount).toBe('number');
    expect(typeof body.errorCount).toBe('number');
  });

  it('returns 401 without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/cache/warmup/summary' });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /cache/warmup/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; delete process.env.ADMIN_API_KEY; });

  it('returns target by id', async () => {
    const t = createTarget();
    const res = await server.inject({ method: 'GET', url: `/cache/warmup/${t.id}`, headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(t.id);
  });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({ method: 'GET', url: '/cache/warmup/no-such-id', headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /cache/warmup/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; delete process.env.ADMIN_API_KEY; });

  it('updates a target', async () => {
    const t = createTarget();
    const res = await server.inject({
      method: 'PATCH', url: `/cache/warmup/${t.id}`,
      headers: ADMIN_HEADERS,
      body: { name: 'Updated', enabled: false, priority: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('Updated');
    expect(body.enabled).toBe(false);
    expect(body.priority).toBe(5);
  });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'PATCH', url: '/cache/warmup/no-such',
      headers: ADMIN_HEADERS,
      body: { name: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /cache/warmup/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; delete process.env.ADMIN_API_KEY; });

  it('deletes a target and returns 204', async () => {
    const t = createTarget();
    const res = await server.inject({ method: 'DELETE', url: `/cache/warmup/${t.id}`, headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(204);
    expect(getWarmupStore().get(t.id)).toBeUndefined();
  });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/cache/warmup/no-such', headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /cache/warmup/:id/history', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; delete process.env.ADMIN_API_KEY; });

  it('returns empty history for new target', async () => {
    const t = createTarget();
    const res = await server.inject({ method: 'GET', url: `/cache/warmup/${t.id}/history`, headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.targetId).toBe(t.id);
    expect(body.history).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it('returns run history', async () => {
    const t = createTarget();
    getWarmupStore().recordRun(t.id, {
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      durationMs: 100, status: 'done',
    });
    const res = await server.inject({ method: 'GET', url: `/cache/warmup/${t.id}/history`, headers: ADMIN_HEADERS });
    const body = JSON.parse(res.body);
    expect(body.total).toBe(1);
    expect(body.history).toHaveLength(1);
  });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({ method: 'GET', url: '/cache/warmup/no-such/history', headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /cache/warmup/:id/run', () => {
  let server: FastifyInstance;
  beforeEach(() => {
    setup();
    server = buildServer();
    // Mock warmOne to avoid real scan calls
    vi.spyOn(getCacheWarmer(), 'warmOne').mockResolvedValue({
      runId: 'mock-run-id',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 50,
      status: 'done',
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    delete process.env.ADMIN_API_KEY;
  });

  it('warms a single target and returns 200', async () => {
    const t = createTarget();
    const res = await server.inject({
      method: 'POST', url: `/cache/warmup/${t.id}/run`, headers: ADMIN_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.targetId).toBe(t.id);
    expect(body.cacheHit).toBe(true);
    expect(body.run.status).toBe('done');
  });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({ method: 'POST', url: '/cache/warmup/no-such/run', headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(404);
  });

  it('returns 502 when warmOne returns error status', async () => {
    vi.restoreAllMocks();
    vi.spyOn(getCacheWarmer(), 'warmOne').mockResolvedValue({
      runId: 'err-run',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 10,
      status: 'error',
      error: 'provider unavailable',
    });
    const t = createTarget({ name: 'Err target', text: 'err text' });
    const res = await server.inject({ method: 'POST', url: `/cache/warmup/${t.id}/run`, headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(502);
  });
});

describe('POST /cache/warmup/run', () => {
  let server: FastifyInstance;
  beforeEach(() => {
    setup();
    server = buildServer();
    vi.spyOn(getCacheWarmer(), 'warmAll').mockResolvedValue([
      {
        targetId: 'mock-id',
        name: 'Mock Target',
        run: {
          runId: 'r1', startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(), durationMs: 80, status: 'done',
        },
      },
    ]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    delete process.env.ADMIN_API_KEY;
  });

  it('returns 207 with warm results', async () => {
    const res = await server.inject({ method: 'POST', url: '/cache/warmup/run', headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(207);
    const body = JSON.parse(res.body);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.results).toHaveLength(1);
    expect(body.triggeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns 401 without auth', async () => {
    const res = await server.inject({ method: 'POST', url: '/cache/warmup/run' });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /cache/warmup/suggestions', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; delete process.env.ADMIN_API_KEY; });

  it('returns suggestions shape', async () => {
    const res = await server.inject({ method: 'GET', url: '/cache/warmup/suggestions', headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('returns 401 without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/cache/warmup/suggestions' });
    expect(res.statusCode).toBe(403);
  });
});
