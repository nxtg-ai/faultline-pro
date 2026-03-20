import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getProviderRegistry,
  resetProviderRegistry,
  AUTO_DISABLE_THRESHOLD,
  AUTO_DISABLE_WINDOW,
} from '../src/store/providers.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetProviderRegistry();
  process.env.FAULTLINE_API_KEY = 'admin-secret';
}

// ── ProviderRegistry — time series tracking ───────────────────────────────────

describe('ProviderRegistry — time series', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('timeSeries is empty initially', () => {
    const snapshot = getProviderRegistry().getHealthSnapshot();
    // No data recorded — no entry in snapshot
    expect(snapshot['gemini']).toBeUndefined();
  });

  it('recordSuccess adds a data point with success=true', () => {
    getProviderRegistry().recordSuccess('gemini', 120);
    const snap = getProviderRegistry().getHealthSnapshot();
    expect(snap['gemini'].timeSeries).toHaveLength(1);
    expect(snap['gemini'].timeSeries[0].success).toBe(true);
    expect(snap['gemini'].timeSeries[0].latencyMs).toBe(120);
  });

  it('recordError adds a data point with success=false', () => {
    getProviderRegistry().recordError('openai');
    const snap = getProviderRegistry().getHealthSnapshot();
    expect(snap['openai'].timeSeries[0].success).toBe(false);
  });

  it('snapshot includes disabled and timeSeries fields', () => {
    getProviderRegistry().recordSuccess('gemini', 80);
    const snap = getProviderRegistry().getHealthSnapshot();
    expect(snap['gemini']).toHaveProperty('disabled');
    expect(snap['gemini']).toHaveProperty('timeSeries');
    expect(snap['gemini'].disabled).toBe(false);
  });
});

// ── ProviderRegistry — auto-disable ──────────────────────────────────────────

describe('ProviderRegistry — auto-disable', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('does not auto-disable with fewer errors than window', () => {
    for (let i = 0; i < AUTO_DISABLE_WINDOW - 1; i++) {
      getProviderRegistry().recordError('gemini');
    }
    expect(getProviderRegistry().isDisabled('gemini')).toBe(false);
  });

  it('auto-disables when error rate exceeds threshold over window', () => {
    // Fill the window with errors (100% error rate → above 80% threshold)
    for (let i = 0; i < AUTO_DISABLE_WINDOW; i++) {
      getProviderRegistry().recordError('gemini');
    }
    expect(getProviderRegistry().isDisabled('gemini')).toBe(true);
  });

  it('auto-disable sets disabledReason', () => {
    for (let i = 0; i < AUTO_DISABLE_WINDOW; i++) {
      getProviderRegistry().recordError('openai');
    }
    const snap = getProviderRegistry().getHealthSnapshot();
    expect(snap['openai'].disabledReason).toBeDefined();
    expect(snap['openai'].disabledReason).toContain('Auto-disabled');
  });

  it('does not auto-disable when error rate is below threshold', () => {
    // 2 errors in 10 calls = 20% < 80%
    for (let i = 0; i < 8; i++) getProviderRegistry().recordSuccess('gemini', 50);
    for (let i = 0; i < 2; i++) getProviderRegistry().recordError('gemini');
    expect(getProviderRegistry().isDisabled('gemini')).toBe(false);
  });

  it('healthScore is 0 for disabled provider', () => {
    for (let i = 0; i < AUTO_DISABLE_WINDOW; i++) getProviderRegistry().recordError('gemini');
    const snap = getProviderRegistry().getHealthSnapshot();
    expect(snap['gemini'].healthScore).toBe(0);
  });
});

// ── ProviderRegistry — manual disable/enable ─────────────────────────────────

describe('ProviderRegistry — manual disable/enable', () => {
  beforeEach(setup);
  afterEach(() => { delete process.env.FAULTLINE_API_KEY; });

  it('setDisabled marks provider as disabled', () => {
    getProviderRegistry().setDisabled('gemini', 'Maintenance window.');
    expect(getProviderRegistry().isDisabled('gemini')).toBe(true);
    const snap = getProviderRegistry().getHealthSnapshot();
    expect(snap['gemini'].disabledReason).toBe('Maintenance window.');
  });

  it('setEnabled clears disabled state', () => {
    getProviderRegistry().setDisabled('gemini');
    getProviderRegistry().setEnabled('gemini');
    expect(getProviderRegistry().isDisabled('gemini')).toBe(false);
    const snap = getProviderRegistry().getHealthSnapshot();
    expect(snap['gemini'].disabledReason).toBeUndefined();
  });
});

// ── HTTP: GET /providers/health/view ─────────────────────────────────────────

describe('GET /providers/health/view', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns 200 with text/html', async () => {
    const res = await server.inject({
      method: 'GET', url: '/providers/health/view',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('HTML contains Provider Health Monitor heading', async () => {
    const res = await server.inject({
      method: 'GET', url: '/providers/health/view',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.body).toContain('Provider Health Monitor');
  });

  it('returns 4xx without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/providers/health/view' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ── HTTP: POST /providers/:name/disable ──────────────────────────────────────

describe('POST /providers/:name/disable', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('disables a provider (admin)', async () => {
    const res = await server.inject({
      method: 'POST', url: '/providers/gemini/disable',
      headers: { 'x-api-key': 'admin-secret' },
      payload: { reason: 'Planned maintenance' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.disabled).toBe(true);
    expect(body.name).toBe('gemini');
  });

  it('provider appears disabled in health snapshot after disable', async () => {
    await server.inject({
      method: 'POST', url: '/providers/openai/disable',
      headers: { 'x-api-key': 'admin-secret' },
      payload: {},
    });
    const healthRes = await server.inject({
      method: 'GET', url: '/providers/health',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const health = JSON.parse(healthRes.body);
    const openai = health.providers.find((p: { name: string }) => p.name === 'openai');
    expect(openai?.metrics?.disabled).toBe(true);
  });

  it('returns 4xx without admin auth', async () => {
    const res = await server.inject({
      method: 'POST', url: '/providers/gemini/disable',
      payload: {},
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ── HTTP: POST /providers/:name/enable ───────────────────────────────────────

describe('POST /providers/:name/enable', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('re-enables a disabled provider', async () => {
    getProviderRegistry().setDisabled('gemini', 'test');
    const res = await server.inject({
      method: 'POST', url: '/providers/gemini/enable',
      headers: { 'x-api-key': 'admin-secret' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).disabled).toBe(false);
    expect(getProviderRegistry().isDisabled('gemini')).toBe(false);
  });
});

// ── HTTP: GET /providers/health (JSON — existing behaviour unchanged) ─────────

describe('GET /providers/health — JSON response includes new fields', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); delete process.env.FAULTLINE_API_KEY; });

  it('returns timeSeries in metrics when calls have been recorded', async () => {
    getProviderRegistry().recordSuccess('gemini', 100);
    const res = await server.inject({
      method: 'GET', url: '/providers/health',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const body = JSON.parse(res.body);
    const gemini = body.providers.find((p: { name: string }) => p.name === 'gemini');
    expect(gemini?.metrics?.timeSeries).toBeDefined();
    expect(Array.isArray(gemini.metrics.timeSeries)).toBe(true);
    expect(gemini.metrics.timeSeries.length).toBeGreaterThan(0);
  });

  it('disabled field included in metrics', async () => {
    getProviderRegistry().setDisabled('openai');
    const res = await server.inject({
      method: 'GET', url: '/providers/health',
      headers: { 'x-api-key': 'admin-secret' },
    });
    const body = JSON.parse(res.body);
    const openai = body.providers.find((p: { name: string }) => p.name === 'openai');
    expect(openai?.metrics?.disabled).toBe(true);
  });
});
