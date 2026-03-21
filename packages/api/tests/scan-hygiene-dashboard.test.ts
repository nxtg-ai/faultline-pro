/**
 * N-99 — Scan hygiene HTML dashboard (GET /scans/stale/view)
 *
 * KSH1–KSH15  HTTP: content-type, structure, auth, chips, badges, params
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getScanHistory, resetScanHistory, hashText } from '../src/store/scan-history.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { resetAuditLogger } from '../src/store/audit.js';
import { resetAnalytics } from '../src/store/analytics.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import type { FastifyInstance } from 'fastify';

const API_KEY = 'api-key-scan-hygiene-test';

function authHeader(): Record<string, string> {
  return { 'x-api-key': API_KEY };
}

function addScan(text: string, opts: {
  daysAgo?: number;
  risk?: string;
  provider?: string;
} = {}): void {
  getScanHistory().record({
    textHash:    hashText(text),
    textPreview: text.slice(0, 100),
    provider:    opts.provider ?? 'mock',
    overallRisk: opts.risk     ?? 'Low',
    claimCount:  2,
    latencyMs:   60,
    timestamp:   new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000).toISOString(),
    keyId:       'k1',
  });
}

describe('GET /scans/stale/view — HTML dashboard', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = API_KEY;
    resetKeyStore();
    resetScanHistory();
    resetAuditLogger();
    resetAnalytics();
    resetCache();
    resetCircuitBreaker();
    getKeyStore().create('Hygiene-Test Key');
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('KSH1: returns 200 with content-type text/html', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('KSH2: response is valid HTML with title and heading', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('Scan Hygiene');
  });

  it('KSH3: 401 without api key', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view' });
    expect(res.statusCode).toBe(401);
  });

  it('KSH4: empty history — shows "No scan history found" empty state', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.body).toContain('No scan history found');
  });

  it('KSH5: includes auto-refresh meta tag', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.body).toContain('http-equiv="refresh"');
  });

  it('KSH6: stale scan — shows STALE chip', async () => {
    addScan('Old document text', { daysAgo: 31 });
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.body).toContain('STALE');
  });

  it('KSH7: fresh scan — no STALE chip', async () => {
    addScan('Fresh document', { daysAgo: 1 });
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.body).not.toContain('STALE');
  });

  it('KSH8: risk-drifted document — shows DRIFT chip', async () => {
    addScan('Drifty text', { risk: 'Low',  daysAgo: 5 });
    addScan('Drifty text', { risk: 'High', daysAgo: 0 });
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.body).toContain('DRIFT');
  });

  it('KSH9: stable risk — no DRIFT chip', async () => {
    addScan('Stable text', { risk: 'Low', daysAgo: 2 });
    addScan('Stable text', { risk: 'Low', daysAgo: 0 });
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.body).not.toContain('DRIFT');
  });

  it('KSH10: text preview appears in table row', async () => {
    addScan('Climate change claim text here');
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.body).toContain('Climate change claim');
  });

  it('KSH11: summary badges show correct counts', async () => {
    addScan('Doc stale', { daysAgo: 31 });
    addScan('Doc fresh', { daysAgo: 0 });

    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    // Total = 2, Stale = 1
    expect(res.body).toContain('>2<');
    expect(res.body).toContain('>1<');
    expect(res.body).toContain('Stale');
  });

  it('KSH12: ?staleDays shown in page header', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view?staleDays=14', headers: authHeader() });
    expect(res.body).toContain('14');
    expect(res.body).toContain('stale');
  });

  it('KSH13: ?staleDays changes stale threshold', async () => {
    addScan('Borderline', { daysAgo: 8 }); // stale at 7d, not at 30d

    const res7  = await server.inject({ method: 'GET', url: '/scans/stale/view?staleDays=7',  headers: authHeader() });
    const res30 = await server.inject({ method: 'GET', url: '/scans/stale/view?staleDays=30', headers: authHeader() });

    expect(res7.body).toContain('STALE');
    expect(res30.body).not.toContain('STALE');
  });

  it('KSH14: Risk Drifted badge count in summary', async () => {
    addScan('Drift A', { risk: 'Low',  daysAgo: 3 });
    addScan('Drift A', { risk: 'High', daysAgo: 0 });
    addScan('Stable', { risk: 'Low',   daysAgo: 0 });

    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.body).toContain('Risk Drifted');
    expect(res.body).toContain('DRIFT');
  });

  it('KSH15: table columns — Hash, Preview, Risk/Flags, Scans, Last Verified, Providers, Avg Latency', async () => {
    addScan('Column check', { provider: 'gemini', risk: 'Medium' });
    const res = await server.inject({ method: 'GET', url: '/scans/stale/view', headers: authHeader() });
    expect(res.body).toContain('Hash');
    expect(res.body).toContain('Preview');
    expect(res.body).toContain('Last Verified');
    expect(res.body).toContain('Providers');
    expect(res.body).toContain('Avg Latency');
  });
});
