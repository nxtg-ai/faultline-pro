import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getScheduleStore,
  resetScheduleStore,
  parseCron,
  nextCronTime,
} from '../src/store/schedules.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetScheduleStore();
  process.env.FAULTLINE_API_KEY = 'test-key';
}

// ── parseCron ─────────────────────────────────────────────────────────────────

describe('parseCron', () => {
  it('accepts a valid 5-field expression', () => {
    expect(parseCron('0 9 * * 1').valid).toBe(true);
  });

  it('rejects fewer than 5 fields', () => {
    const r = parseCron('0 9 * *');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('5 fields');
  });

  it('rejects more than 5 fields', () => {
    expect(parseCron('0 9 * * 1 2026').valid).toBe(false);
  });

  it('accepts wildcard *', () => {
    expect(parseCron('* * * * *').valid).toBe(true);
  });

  it('accepts step */5', () => {
    expect(parseCron('*/5 * * * *').valid).toBe(true);
  });

  it('rejects step */0', () => {
    expect(parseCron('*/0 * * * *').valid).toBe(false);
  });

  it('accepts comma-separated values', () => {
    expect(parseCron('0 9,18 * * *').valid).toBe(true);
  });

  it('accepts ranges', () => {
    expect(parseCron('0 9 1-15 * *').valid).toBe(true);
  });

  it('rejects out-of-range minute', () => {
    const r = parseCron('60 9 * * *');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('Field 1');
  });

  it('rejects out-of-range hour', () => {
    expect(parseCron('0 24 * * *').valid).toBe(false);
  });

  it('rejects inverted range', () => {
    expect(parseCron('0 9 31-1 * *').valid).toBe(false);
  });
});

// ── nextCronTime ──────────────────────────────────────────────────────────────

describe('nextCronTime', () => {
  it('returns a Date in the future', () => {
    const next = nextCronTime('0 9 * * *');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it('result matches cron fields (hour)', () => {
    const after = new Date('2025-01-01T00:00:00Z');
    const next = nextCronTime('0 9 * * *', after);
    expect(next?.getUTCHours()).toBe(9);
    expect(next?.getUTCMinutes()).toBe(0);
  });

  it('advances past after by at least 1 minute', () => {
    const after = new Date('2025-01-01T09:00:00Z');
    const next = nextCronTime('0 9 * * *', after);
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
  });

  it('returns null for unmatchable expression (leap year safety)', () => {
    // 31st of Feb never exists
    const after = new Date('2025-01-01T00:00:00Z');
    const next = nextCronTime('0 0 31 2 *', after);
    expect(next).toBeNull();
  });

  it('handles weekday 7 as Sunday', () => {
    const after = new Date('2025-01-01T00:00:00Z'); // Wednesday
    const next = nextCronTime('0 0 * * 7', after);
    expect(next?.getUTCDay()).toBe(0); // 0 = Sunday
  });
});

// ── ScheduleStore ─────────────────────────────────────────────────────────────

describe('ScheduleStore.create', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('creates a schedule with required fields', () => {
    const s = getScheduleStore().create({ name: 'Test', cron: '0 9 * * *', text: 'hello' }, 'k1');
    expect(s.id).toBeTruthy();
    expect(s.name).toBe('Test');
    expect(s.status).toBe('active');
    expect(s.runCount).toBe(0);
    expect(s.history).toHaveLength(0);
  });

  it('assigns nextRunAt on creation', () => {
    const s = getScheduleStore().create({ name: 'Next', cron: '0 12 * * *', text: 'x' }, 'k1');
    expect(s.nextRunAt).toBeTruthy();
    expect(new Date(s.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('throws if neither text nor url provided', () => {
    expect(() => getScheduleStore().create({ name: 'X', cron: '* * * * *' }, 'k1')).toThrow('Either text or url');
  });

  it('throws on invalid cron', () => {
    expect(() => getScheduleStore().create({ name: 'X', cron: 'bad', text: 'x' }, 'k1')).toThrow();
  });

  it('defaults provider to gemini', () => {
    const s = getScheduleStore().create({ name: 'X', cron: '* * * * *', text: 'x' }, 'k1');
    expect(s.provider).toBe('gemini');
  });
});

describe('ScheduleStore CRUD', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('get returns the schedule by id', () => {
    const s = getScheduleStore().create({ name: 'A', cron: '* * * * *', text: 'x' }, 'k1');
    expect(getScheduleStore().get(s.id)?.name).toBe('A');
  });

  it('get returns undefined for unknown id', () => {
    expect(getScheduleStore().get('nope')).toBeUndefined();
  });

  it('list filters by keyId', () => {
    getScheduleStore().create({ name: 'A', cron: '* * * * *', text: 'x' }, 'k1');
    getScheduleStore().create({ name: 'B', cron: '* * * * *', text: 'x' }, 'k2');
    expect(getScheduleStore().list('k1')).toHaveLength(1);
    expect(getScheduleStore().list('k2')).toHaveLength(1);
    expect(getScheduleStore().list()).toHaveLength(2);
  });

  it('delete removes the schedule', () => {
    const s = getScheduleStore().create({ name: 'D', cron: '* * * * *', text: 'x' }, 'k1');
    getScheduleStore().delete(s.id);
    expect(getScheduleStore().get(s.id)).toBeUndefined();
  });

  it('update patches name and description', () => {
    const s = getScheduleStore().create({ name: 'Old', cron: '* * * * *', text: 'x' }, 'k1');
    const updated = getScheduleStore().update(s.id, { name: 'New', description: 'Desc' });
    expect(updated?.name).toBe('New');
    expect(updated?.description).toBe('Desc');
  });

  it('update recomputes nextRunAt when cron changes', () => {
    const s = getScheduleStore().create({ name: 'T', cron: '* * * * *', text: 'x' }, 'k1');
    const oldNext = s.nextRunAt;
    const updated = getScheduleStore().update(s.id, { cron: '0 12 * * *' });
    expect(updated?.nextRunAt).not.toBe(oldNext);
    expect(updated?.cron).toBe('0 12 * * *');
  });

  it('update throws on invalid cron', () => {
    const s = getScheduleStore().create({ name: 'T', cron: '* * * * *', text: 'x' }, 'k1');
    expect(() => getScheduleStore().update(s.id, { cron: 'bad' })).toThrow();
  });

  it('update returns null for unknown id', () => {
    expect(getScheduleStore().update('nope', { name: 'X' })).toBeNull();
  });
});

describe('ScheduleStore.recordRun', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('increments runCount and adds to history', () => {
    const s = getScheduleStore().create({ name: 'R', cron: '* * * * *', text: 'x' }, 'k1');
    getScheduleStore().recordRun(s.id, {
      ranAt: new Date().toISOString(), durationMs: 100,
      overallRisk: 'low', claimCount: 3, provider: 'gemini',
      inputSource: 'text', inputSize: 5,
    });
    const updated = getScheduleStore().get(s.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.history).toHaveLength(1);
    expect(updated.lastResult?.overallRisk).toBe('low');
  });

  it('caps history at 20 entries', () => {
    const s = getScheduleStore().create({ name: 'H', cron: '* * * * *', text: 'x' }, 'k1');
    for (let i = 0; i < 25; i++) {
      getScheduleStore().recordRun(s.id, {
        ranAt: new Date().toISOString(), durationMs: i,
        overallRisk: 'low', claimCount: 0, provider: 'gemini',
        inputSource: 'text', inputSize: 1,
      });
    }
    expect(getScheduleStore().get(s.id)!.history).toHaveLength(20);
  });

  it('marks status completed when maxRuns reached', () => {
    const s = getScheduleStore().create({ name: 'M', cron: '* * * * *', text: 'x', maxRuns: 2 }, 'k1');
    for (let i = 0; i < 2; i++) {
      getScheduleStore().recordRun(s.id, {
        ranAt: new Date().toISOString(), durationMs: 50,
        overallRisk: 'low', claimCount: 0, provider: 'gemini',
        inputSource: 'text', inputSize: 1,
      });
    }
    expect(getScheduleStore().get(s.id)!.status).toBe('completed');
  });
});

// ── HTTP routes ───────────────────────────────────────────────────────────────

describe('POST /schedules', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('creates a schedule and returns 201', async () => {
    const res = await server.inject({
      method: 'POST', url: '/schedules',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: { name: 'Daily scan', cron: '0 9 * * *', text: 'Some content to monitor.' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('Daily scan');
    expect(body.status).toBe('active');
  });

  it('returns 400 for invalid cron', async () => {
    const res = await server.inject({
      method: 'POST', url: '/schedules',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: { name: 'Bad', cron: 'not-a-cron', text: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when neither text nor url provided', async () => {
    const res = await server.inject({
      method: 'POST', url: '/schedules',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: { name: 'No input', cron: '* * * * *' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 4xx without auth', async () => {
    const res = await server.inject({
      method: 'POST', url: '/schedules',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'X', cron: '* * * * *', text: 'x' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /schedules', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns schedules array', async () => {
    getScheduleStore().create({ name: 'A', cron: '* * * * *', text: 'x' }, 'admin');
    const res = await server.inject({
      method: 'GET', url: '/schedules',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.schedules)).toBe(true);
    expect(body.schedules.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.schedules.length);
  });

  it('returns 4xx without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/schedules' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /schedules/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns the schedule', async () => {
    const s = getScheduleStore().create({ name: 'Get me', cron: '* * * * *', text: 'x' }, 'admin');
    const res = await server.inject({
      method: 'GET', url: '/schedules/' + s.id,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('Get me');
  });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'GET', url: '/schedules/nope',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for schedule owned by another key', async () => {
    const s = getScheduleStore().create({ name: 'Other', cron: '* * * * *', text: 'x' }, 'other-key');
    const res = await server.inject({
      method: 'GET', url: '/schedules/' + s.id,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /schedules/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('updates name and status', async () => {
    const s = getScheduleStore().create({ name: 'Old', cron: '* * * * *', text: 'x' }, 'admin');
    const res = await server.inject({
      method: 'PATCH', url: '/schedules/' + s.id,
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: { name: 'New', status: 'paused' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('New');
    expect(body.status).toBe('paused');
  });

  it('returns 404 for unknown id', async () => {
    const res = await server.inject({
      method: 'PATCH', url: '/schedules/nope',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /schedules/:id', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('deletes and returns 204', async () => {
    const s = getScheduleStore().create({ name: 'Del', cron: '* * * * *', text: 'x' }, 'admin');
    const res = await server.inject({
      method: 'DELETE', url: '/schedules/' + s.id,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(204);
    expect(getScheduleStore().get(s.id)).toBeUndefined();
  });

  it('returns 403 when deleting another key\'s schedule', async () => {
    const s = getScheduleStore().create({ name: 'Other', cron: '* * * * *', text: 'x' }, 'other-key');
    const res = await server.inject({
      method: 'DELETE', url: '/schedules/' + s.id,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /schedules/:id/trigger', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 202 with triggeredAt', async () => {
    const s = getScheduleStore().create({ name: 'Trigger', cron: '* * * * *', text: 'x' }, 'admin');
    const res = await server.inject({
      method: 'POST', url: '/schedules/' + s.id + '/trigger',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.scheduleId).toBe(s.id);
    expect(body.triggeredAt).toBeTruthy();
  });

  it('returns 404 for unknown schedule', async () => {
    const res = await server.inject({
      method: 'POST', url: '/schedules/nope/trigger',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /schedules/:id/history', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns history array', async () => {
    const s = getScheduleStore().create({ name: 'Hist', cron: '* * * * *', text: 'x' }, 'admin');
    getScheduleStore().recordRun(s.id, {
      ranAt: new Date().toISOString(), durationMs: 200,
      overallRisk: 'medium', claimCount: 2, provider: 'gemini',
      inputSource: 'text', inputSize: 1,
    });
    const res = await server.inject({
      method: 'GET', url: '/schedules/' + s.id + '/history',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.history)).toBe(true);
    expect(body.history.length).toBeGreaterThan(0);
    expect(body.history[0].overallRisk).toBe('medium');
  });
});

describe('GET /schedules/view', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with text/html', async () => {
    const res = await server.inject({
      method: 'GET', url: '/schedules/view',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML contains Scan Schedules heading', async () => {
    const res = await server.inject({
      method: 'GET', url: '/schedules/view',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.body).toContain('Scan Schedules');
  });

  it('returns 4xx without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/schedules/view' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
