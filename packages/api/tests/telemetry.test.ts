import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getTelemetryStore,
  resetTelemetryStore,
  latencyBucket,
  inputLengthBucket,
  truncateToHour,
  recordScanTelemetry,
} from '../src/store/telemetry.js';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('latencyBucket', () => {
  it('buckets sub-100ms latency', ()  => expect(latencyBucket(50)).toBe('<100ms'));
  it('buckets 100-500ms latency',  ()  => expect(latencyBucket(250)).toBe('100-500ms'));
  it('buckets 500ms-2s latency',   ()  => expect(latencyBucket(1000)).toBe('500ms-2s'));
  it('buckets >2s latency',        ()  => expect(latencyBucket(3000)).toBe('>2s'));
  it('boundary: 100ms → 100-500ms', () => expect(latencyBucket(100)).toBe('100-500ms'));
  it('boundary: 500ms → 500ms-2s', () => expect(latencyBucket(500)).toBe('500ms-2s'));
});

describe('inputLengthBucket', () => {
  it('buckets short input',    () => expect(inputLengthBucket(200)).toBe('<500'));
  it('buckets medium input',   () => expect(inputLengthBucket(1000)).toBe('500-2000'));
  it('buckets long input',     () => expect(inputLengthBucket(5000)).toBe('2000-10000'));
  it('buckets very long input',() => expect(inputLengthBucket(15000)).toBe('>10000'));
});

describe('truncateToHour', () => {
  it('strips minutes and seconds', () => {
    const result = truncateToHour('2026-03-20T22:34:17.123Z');
    expect(result).toBe('2026-03-20T22:00:00.000Z');
  });
});

// ── TelemetryStore ────────────────────────────────────────────────────────────

describe('TelemetryStore', () => {
  beforeEach(() => {
    resetTelemetryStore();
  });

  afterEach(() => {
    delete process.env.FAULTLINE_TELEMETRY;
  });

  it('isEnabled returns false when FAULTLINE_TELEMETRY is unset', () => {
    delete process.env.FAULTLINE_TELEMETRY;
    expect(getTelemetryStore().isEnabled()).toBe(false);
  });

  it('isEnabled returns true when FAULTLINE_TELEMETRY=1', () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    expect(getTelemetryStore().isEnabled()).toBe(true);
  });

  it('record() is a no-op when telemetry disabled', () => {
    delete process.env.FAULTLINE_TELEMETRY;
    getTelemetryStore().record({
      hour: '2026-03-20T22:00:00.000Z', provider: 'gemini', riskLevel: 'low',
      claimCount: 3, claimTypes: {}, latencyBucket: '<100ms',
      inputLengthBucket: '<500', cacheHit: false,
    });
    expect(getTelemetryStore().getEvents()).toHaveLength(0);
  });

  it('record() stores event when telemetry enabled', () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    getTelemetryStore().record({
      hour: '2026-03-20T22:00:00.000Z', provider: 'gemini', riskLevel: 'low',
      claimCount: 3, claimTypes: { fact: 2, opinion: 1 }, latencyBucket: '<100ms',
      inputLengthBucket: '<500', cacheHit: false,
    });
    expect(getTelemetryStore().getEvents()).toHaveLength(1);
  });

  it('getDashboard totals reflect recorded events', () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    for (let i = 0; i < 5; i++) {
      getTelemetryStore().record({
        hour: '2026-03-20T22:00:00.000Z', provider: 'gemini', riskLevel: 'low',
        claimCount: 2, claimTypes: { fact: 2 }, latencyBucket: '<100ms',
        inputLengthBucket: '<500', cacheHit: i % 2 === 0,
      });
    }
    const dash = getTelemetryStore().getDashboard();
    expect(dash.totals.events).toBe(5);
    expect(dash.totals.cacheHits).toBe(3); // i=0,2,4
  });

  it('getDashboard computes error rate', () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    getTelemetryStore().record({ hour: '2026-03-20T22:00:00.000Z', provider: 'gemini', riskLevel: 'low',    claimCount: 1, claimTypes: {}, latencyBucket: '<100ms', inputLengthBucket: '<500', cacheHit: false });
    getTelemetryStore().record({ hour: '2026-03-20T22:00:00.000Z', provider: 'gemini', riskLevel: 'unknown', claimCount: 0, claimTypes: {}, latencyBucket: '<100ms', inputLengthBucket: '<500', cacheHit: false, errorCode: 500 });
    const dash = getTelemetryStore().getDashboard();
    expect(dash.totals.errors).toBe(1);
    expect(dash.totals.errorRate).toBe(0.5);
  });

  it('getDashboard provider breakdown sums correctly', () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    const providers = ['gemini', 'gemini', 'openai'];
    for (const p of providers) {
      getTelemetryStore().record({ hour: '2026-03-20T22:00:00.000Z', provider: p, riskLevel: 'low', claimCount: 1, claimTypes: {}, latencyBucket: '<100ms', inputLengthBucket: '<500', cacheHit: false });
    }
    const dash = getTelemetryStore().getDashboard();
    expect(dash.providers['gemini']?.count).toBe(2);
    expect(dash.providers['openai']?.count).toBe(1);
    expect(dash.providers['gemini']?.pct).toBe(67);
  });

  it('getDashboard risk distribution counts correctly', () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    for (const r of ['low', 'low', 'high']) {
      getTelemetryStore().record({ hour: '2026-03-20T22:00:00.000Z', provider: 'gemini', riskLevel: r, claimCount: 1, claimTypes: {}, latencyBucket: '<100ms', inputLengthBucket: '<500', cacheHit: false });
    }
    const dash = getTelemetryStore().getDashboard();
    expect(dash.riskDistribution['low']).toBe(2);
    expect(dash.riskDistribution['high']).toBe(1);
  });

  it('getDashboard aggregates claim types across events', () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    getTelemetryStore().record({ hour: '2026-03-20T22:00:00.000Z', provider: 'gemini', riskLevel: 'low', claimCount: 2, claimTypes: { fact: 2 }, latencyBucket: '<100ms', inputLengthBucket: '<500', cacheHit: false });
    getTelemetryStore().record({ hour: '2026-03-20T22:00:00.000Z', provider: 'gemini', riskLevel: 'low', claimCount: 1, claimTypes: { fact: 1, opinion: 1 }, latencyBucket: '<100ms', inputLengthBucket: '<500', cacheHit: false });
    const dash = getTelemetryStore().getDashboard();
    expect(dash.claimTypes['fact']).toBe(3);
    expect(dash.claimTypes['opinion']).toBe(1);
  });

  it('getDashboard returns 24 hourly buckets', () => {
    const dash = getTelemetryStore().getDashboard();
    expect(dash.hourly).toHaveLength(24);
  });

  it('getDashboard includes privacy guarantees', () => {
    const dash = getTelemetryStore().getDashboard();
    expect(dash.privacy.noTextContent).toBe(true);
    expect(dash.privacy.noUserIdentity).toBe(true);
    expect(dash.privacy.noIpAddress).toBe(true);
  });

  it('recordScanTelemetry convenience wrapper stores event', () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    recordScanTelemetry({ provider: 'openai', riskLevel: 'medium', claimCount: 4, claimTypes: { fact: 4 }, latencyMs: 350, inputLength: 1200, cacheHit: false });
    const events = getTelemetryStore().getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.latencyBucket).toBe('100-500ms');
    expect(events[0]?.inputLengthBucket).toBe('500-2000');
  });
});

// ── HTTP endpoints ────────────────────────────────────────────────────────────

describe('GET /telemetry/status', () => {
  let server: FastifyInstance;
  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_TELEMETRY; });

  it('returns 200 with enabled field (public — no auth)', async () => {
    const res = await server.inject({ method: 'GET', url: '/telemetry/status' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.enabled).toBe('boolean');
    expect(body.privacyPolicy).toBe('/telemetry/privacy');
  });

  it('enabled=false when env var unset', async () => {
    delete process.env.FAULTLINE_TELEMETRY;
    const res = await server.inject({ method: 'GET', url: '/telemetry/status' });
    expect(JSON.parse(res.body).enabled).toBe(false);
  });

  it('enabled=true when FAULTLINE_TELEMETRY=1', async () => {
    process.env.FAULTLINE_TELEMETRY = '1';
    const res = await server.inject({ method: 'GET', url: '/telemetry/status' });
    expect(JSON.parse(res.body).enabled).toBe(true);
  });
});

describe('GET /telemetry/privacy', () => {
  let server: FastifyInstance;
  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('returns 200 (public — no auth)', async () => {
    const res = await server.inject({ method: 'GET', url: '/telemetry/privacy' });
    expect(res.statusCode).toBe(200);
  });

  it('lists collectedFields and neverCollectedFields', async () => {
    const res = await server.inject({ method: 'GET', url: '/telemetry/privacy' });
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.collectedFields)).toBe(true);
    expect(body.collectedFields.length).toBeGreaterThan(0);
    expect(Array.isArray(body.neverCollectedFields)).toBe(true);
    expect(body.neverCollectedFields.some((f: string) => f.includes('text'))).toBe(true);
  });

  it('retention states no disk persistence', async () => {
    const res = await server.inject({ method: 'GET', url: '/telemetry/privacy' });
    const body = JSON.parse(res.body);
    expect(body.retention.persistedToDisk).toBe(false);
    expect(body.retention.sentToExternalService).toBe(false);
  });
});

describe('GET /telemetry/dashboard', () => {
  let server: FastifyInstance;
  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = 'test-key';
    process.env.FAULTLINE_TELEMETRY = '1';
    resetTelemetryStore();
    server = buildServer();
  });
  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    delete process.env.FAULTLINE_TELEMETRY;
  });

  it('returns 401 without API key', async () => {
    const res = await server.inject({ method: 'GET', url: '/telemetry/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with valid key', async () => {
    const res = await server.inject({
      method: 'GET', url: '/telemetry/dashboard',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('dashboard has all required top-level fields', async () => {
    const res = await server.inject({
      method: 'GET', url: '/telemetry/dashboard',
      headers: { 'x-api-key': 'test-key' },
    });
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('generatedAt');
    expect(body).toHaveProperty('optInEnabled');
    expect(body).toHaveProperty('totals');
    expect(body).toHaveProperty('providers');
    expect(body).toHaveProperty('riskDistribution');
    expect(body).toHaveProperty('latencyDistribution');
    expect(body).toHaveProperty('claimTypes');
    expect(body).toHaveProperty('hourly');
    expect(body).toHaveProperty('privacy');
  });

  it('hourly array has 24 entries', async () => {
    const res = await server.inject({
      method: 'GET', url: '/telemetry/dashboard',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(JSON.parse(res.body).hourly).toHaveLength(24);
  });
});

describe('GET /telemetry', () => {
  let server: FastifyInstance;
  beforeEach(() => { server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('returns 200 with text/html (public)', async () => {
    const res = await server.inject({ method: 'GET', url: '/telemetry' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML references /telemetry/dashboard', async () => {
    const res = await server.inject({ method: 'GET', url: '/telemetry' });
    expect(res.body).toContain('/telemetry/dashboard');
  });
});
