/**
 * N-96 — Stale scan detection (GET /scans/stale)
 *
 * KSS1–KSS5   ScanHistoryStore unit: getStaleScanGroups() grouping logic
 * KSS6–KSS15  HTTP: GET /scans/stale with various thresholds and scenarios
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

const API_KEY = 'api-key-scan-stale-test';

function authHeader(): Record<string, string> {
  return { 'x-api-key': API_KEY };
}

function makeEntry(text: string, daysAgo: number, provider = 'mock', risk = 'Low'): void {
  getScanHistory().record({
    textHash:    hashText(text),
    textPreview: text.slice(0, 100),
    provider,
    overallRisk: risk,
    claimCount:  2,
    latencyMs:   50,
    timestamp:   new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    keyId:       'k1',
  });
}

// ── Store unit tests ─────────────────────────────────────────────────────────

describe('ScanHistoryStore — getStaleScanGroups()', () => {
  beforeEach(() => resetScanHistory());

  it('KSS1: empty history → empty result', () => {
    expect(getScanHistory().getStaleScanGroups(30)).toHaveLength(0);
  });

  it('KSS2: scan from 31 days ago → included at 30d threshold', () => {
    makeEntry('old text', 31);
    const result = getScanHistory().getStaleScanGroups(30);
    expect(result).toHaveLength(1);
    expect(result[0].textHash).toBe(hashText('old text'));
  });

  it('KSS3: scan from today → excluded at 30d threshold', () => {
    makeEntry('fresh text', 0);
    expect(getScanHistory().getStaleScanGroups(30)).toHaveLength(0);
  });

  it('KSS4: same text scanned twice — most recent determines staleness', () => {
    // Old scan first, then a recent re-verification
    makeEntry('checked text', 45);  // old
    makeEntry('checked text', 2);   // recent re-scan of same text

    // Most recent scan is 2 days ago → NOT stale at 30d
    expect(getScanHistory().getStaleScanGroups(30)).toHaveLength(0);
  });

  it('KSS5: two distinct texts — one stale, one fresh → only stale returned', () => {
    makeEntry('stale doc', 31);
    makeEntry('fresh doc', 1);

    const result = getScanHistory().getStaleScanGroups(30);
    expect(result).toHaveLength(1);
    expect(result[0].textHash).toBe(hashText('stale doc'));
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('GET /scans/stale — HTTP', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = API_KEY;
    resetKeyStore();
    resetScanHistory();
    resetAuditLogger();
    resetAnalytics();
    resetCache();
    resetCircuitBreaker();
    getKeyStore().create('Stale-Test Key');
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('KSS6: empty history → 200 with count:0 and empty scans array', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/stale', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(body.scans).toHaveLength(0);
    expect(body.days).toBe(30); // default
  });

  it('KSS7: stale scan → appears in result with correct textHash', async () => {
    makeEntry('old document', 31);

    const res = await server.inject({ method: 'GET', url: '/scans/stale', headers: authHeader() });
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.scans[0].textHash).toBe(hashText('old document'));
  });

  it('KSS8: fresh scan → excluded from stale list', async () => {
    makeEntry('recent doc', 0);

    const res = await server.inject({ method: 'GET', url: '/scans/stale', headers: authHeader() });
    expect(JSON.parse(res.body).count).toBe(0);
  });

  it('KSS9: ?days=7 — uses 7-day threshold', async () => {
    makeEntry('week old', 8);  // stale at 7d
    makeEntry('recent', 2);    // not stale at 7d

    const res = await server.inject({ method: 'GET', url: '/scans/stale?days=7', headers: authHeader() });
    const body = JSON.parse(res.body);
    expect(body.days).toBe(7);
    expect(body.count).toBe(1);
    expect(body.scans[0].textHash).toBe(hashText('week old'));
  });

  it('KSS10: same text re-scanned recently — not stale even if originally scanned long ago', async () => {
    makeEntry('re-checked', 60); // old scan
    makeEntry('re-checked', 1);  // recent re-verification

    const res = await server.inject({ method: 'GET', url: '/scans/stale', headers: authHeader() });
    expect(JSON.parse(res.body).count).toBe(0);
  });

  it('KSS11: 401 without api key', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/stale' });
    expect(res.statusCode).toBe(401);
  });

  it('KSS12: response includes textPreview and provider fields', async () => {
    makeEntry('verifiable claim text', 31, 'gemini', 'High');

    const res = await server.inject({ method: 'GET', url: '/scans/stale', headers: authHeader() });
    const scan = JSON.parse(res.body).scans[0];
    expect(scan.textPreview).toContain('verifiable claim text');
    expect(scan.provider).toBe('gemini');
    expect(scan.overallRisk).toBe('High');
  });

  it('KSS13: multiple stale documents returned, oldest first', async () => {
    makeEntry('oldest', 90);
    makeEntry('middle', 60);
    makeEntry('least old', 31);

    const res = await server.inject({ method: 'GET', url: '/scans/stale', headers: authHeader() });
    const body = JSON.parse(res.body);
    expect(body.count).toBe(3);
    // Oldest first
    const timestamps = body.scans.map((s: { timestamp: string }) => new Date(s.timestamp).getTime());
    expect(timestamps[0]).toBeLessThan(timestamps[1]);
    expect(timestamps[1]).toBeLessThan(timestamps[2]);
  });

  it('KSS14: days clamped to 365 maximum', async () => {
    const res = await server.inject({ method: 'GET', url: '/scans/stale?days=99999', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).days).toBe(365);
  });

  it('KSS15: count matches scans array length', async () => {
    makeEntry('doc A', 35);
    makeEntry('doc B', 40);
    makeEntry('doc C fresh', 2); // excluded

    const res = await server.inject({ method: 'GET', url: '/scans/stale', headers: authHeader() });
    const body = JSON.parse(res.body);
    expect(body.count).toBe(body.scans.length);
    expect(body.count).toBe(2);
  });
});
