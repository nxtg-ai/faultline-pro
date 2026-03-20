import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';
import {
  getUptimeMs,
  formatUptime,
  deriveIncidents,
  bucketResponseTimes,
  resetStatusClock,
} from '../src/store/status.js';
import type { AuditEntry } from '../src/store/audit.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp:  new Date().toISOString(),
    keyId:      'test-key',
    endpoint:   '/scan',
    method:     'POST',
    statusCode: 200,
    latencyMs:  120,
    ...overrides,
  };
}

// ── formatUptime ──────────────────────────────────────────────────────────────

describe('formatUptime', () => {
  it('formats seconds only', () => {
    expect(formatUptime(42_000)).toBe('42s');
  });

  it('formats minutes and seconds', () => {
    expect(formatUptime(90_000)).toBe('1m 30s');
  });

  it('formats hours, minutes, seconds', () => {
    expect(formatUptime(3_661_000)).toBe('1h 1m 1s');
  });

  it('formats days, hours, minutes', () => {
    expect(formatUptime(90_061_000)).toBe('1d 1h 1m');
  });
});

// ── getUptimeMs ───────────────────────────────────────────────────────────────

describe('getUptimeMs', () => {
  beforeEach(() => resetStatusClock());

  it('returns a positive number immediately after reset', () => {
    expect(getUptimeMs()).toBeGreaterThanOrEqual(0);
  });

  it('increases over time', async () => {
    const t1 = getUptimeMs();
    await new Promise(r => setTimeout(r, 10));
    const t2 = getUptimeMs();
    expect(t2).toBeGreaterThan(t1);
  });
});

// ── deriveIncidents ───────────────────────────────────────────────────────────

describe('deriveIncidents', () => {
  it('returns empty array when no incidents', () => {
    expect(deriveIncidents([makeEntry()])).toHaveLength(0);
  });

  it('detects 5xx error as an incident', () => {
    const result = deriveIncidents([makeEntry({ statusCode: 500 })]);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('error');
    expect(result[0]!.description).toContain('500');
  });

  it('detects high-latency request as an incident', () => {
    const result = deriveIncidents([makeEntry({ latencyMs: 6000 })]);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('latency');
    expect(result[0]!.description).toContain('6000');
  });

  it('ignores 4xx responses', () => {
    expect(deriveIncidents([makeEntry({ statusCode: 404 })])).toHaveLength(0);
  });

  it('ignores latency below threshold', () => {
    expect(deriveIncidents([makeEntry({ latencyMs: 4999 })])).toHaveLength(0);
  });

  it('respects the limit parameter', () => {
    const entries = Array.from({ length: 20 }, () => makeEntry({ statusCode: 500 }));
    expect(deriveIncidents(entries, 5)).toHaveLength(5);
  });

  it('returns newest incidents first', () => {
    const entries = [
      makeEntry({ statusCode: 500, timestamp: '2026-03-01T10:00:00.000Z' }),
      makeEntry({ statusCode: 500, timestamp: '2026-03-01T12:00:00.000Z' }),
    ];
    const result = deriveIncidents(entries);
    expect(result[0]!.timestamp).toBe('2026-03-01T12:00:00.000Z');
  });
});

// ── bucketResponseTimes ───────────────────────────────────────────────────────

describe('bucketResponseTimes', () => {
  it('returns 60 buckets for default 60-min window', () => {
    expect(bucketResponseTimes([])).toHaveLength(60);
  });

  it('all buckets have count 0 when no entries', () => {
    const buckets = bucketResponseTimes([]);
    expect(buckets.every(b => b.count === 0)).toBe(true);
  });

  it('places a recent entry into the last bucket', () => {
    const entry = makeEntry({ latencyMs: 200 });
    const buckets = bucketResponseTimes([entry]);
    const nonZero = buckets.filter(b => b.count > 0);
    expect(nonZero).toHaveLength(1);
    expect(nonZero[0]!.p50Ms).toBe(200);
  });

  it('ignores entries older than the window', () => {
    const old = makeEntry({
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      latencyMs: 999,
    });
    const buckets = bucketResponseTimes([old]);
    expect(buckets.every(b => b.count === 0)).toBe(true);
  });

  it('bucket labels are HH:MM format', () => {
    const buckets = bucketResponseTimes([]);
    expect(buckets[0]!.label).toMatch(/^\d{2}:\d{2}$/);
  });
});

// ── HTTP endpoints ────────────────────────────────────────────────────────────

describe('GET /status', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 200 with text/html content-type', async () => {
    const res = await server.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML contains Faultline branding', async () => {
    const res = await server.inject({ method: 'GET', url: '/status' });
    // Title has "Faultline Pro"; logo splits the word across spans
    expect(res.body).toContain('Faultline Pro');
  });

  it('HTML contains provider names', async () => {
    const res = await server.inject({ method: 'GET', url: '/status' });
    expect(res.body).toContain('Gemini');
    expect(res.body).toContain('OpenAI');
    expect(res.body).toContain('Claude');
    expect(res.body).toContain('Perplexity');
  });

  it('HTML references /status.json for polling', async () => {
    const res = await server.inject({ method: 'GET', url: '/status' });
    expect(res.body).toContain('/status.json');
  });

  it('HTML contains auto-refresh logic', async () => {
    const res = await server.inject({ method: 'GET', url: '/status' });
    expect(res.body).toContain('setInterval');
  });
});

describe('GET /status.json', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns 200 with application/json', async () => {
    const res = await server.inject({ method: 'GET', url: '/status.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('response has all required top-level fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/status.json' });
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('generatedAt');
    expect(body).toHaveProperty('uptimeMs');
    expect(body).toHaveProperty('uptimeFormatted');
    expect(body).toHaveProperty('overallStatus');
    expect(body).toHaveProperty('providers');
    expect(body).toHaveProperty('responseTimes');
    expect(body).toHaveProperty('incidents');
    expect(body).toHaveProperty('scanStats');
  });

  it('providers array has 4 entries', async () => {
    const res = await server.inject({ method: 'GET', url: '/status.json' });
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers).toHaveLength(4);
  });

  it('each provider has name and status fields', async () => {
    const res = await server.inject({ method: 'GET', url: '/status.json' });
    const body = JSON.parse(res.body);
    for (const p of body.providers) {
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('status');
    }
  });

  it('uptimeMs is a positive number', async () => {
    const res = await server.inject({ method: 'GET', url: '/status.json' });
    const body = JSON.parse(res.body);
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it('responseTimes is an array of 60 buckets', async () => {
    const res = await server.inject({ method: 'GET', url: '/status.json' });
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.responseTimes)).toBe(true);
    expect(body.responseTimes).toHaveLength(60);
  });

  it('incidents is an array', async () => {
    const res = await server.inject({ method: 'GET', url: '/status.json' });
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.incidents)).toBe(true);
  });

  it('overallStatus is operational or degraded', async () => {
    const res = await server.inject({ method: 'GET', url: '/status.json' });
    const body = JSON.parse(res.body);
    expect(['operational', 'degraded']).toContain(body.overallStatus);
  });

  it('does not require authentication', async () => {
    // No x-api-key header — should still return 200
    const res = await server.inject({ method: 'GET', url: '/status.json' });
    expect(res.statusCode).toBe(200);
  });
});
