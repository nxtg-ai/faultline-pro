/**
 * N-98 — Bulk scan pruning (DELETE /scans/stale)
 *
 * KSP1–KSP5   ScanHistoryStore unit: pruneStaleGroups()
 * KSP6–KSP15  HTTP: DELETE /scans/stale
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

const ADMIN_KEY = 'admin-key-scan-prune-test';

function adminHeader(): Record<string, string> {
  return { 'x-api-key': ADMIN_KEY };
}

function addScan(text: string, daysAgo = 0, provider = 'mock'): void {
  getScanHistory().record({
    textHash:    hashText(text),
    textPreview: text.slice(0, 100),
    provider,
    overallRisk: 'Low',
    claimCount:  1,
    latencyMs:   40,
    timestamp:   new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    keyId:       'k1',
  });
}

// ── Store unit tests ─────────────────────────────────────────────────────────

describe('ScanHistoryStore — pruneStaleGroups()', () => {
  beforeEach(() => resetScanHistory());

  it('KSP1: empty history → deletedGroups:0, deletedEntries:0', () => {
    const result = getScanHistory().pruneStaleGroups(30);
    expect(result.deletedGroups).toBe(0);
    expect(result.deletedEntries).toBe(0);
  });

  it('KSP2: one stale group → deleted, history becomes empty', () => {
    addScan('Stale doc', 31);
    const result = getScanHistory().pruneStaleGroups(30);
    expect(result.deletedGroups).toBe(1);
    expect(result.deletedEntries).toBe(1);
    expect(getScanHistory().size).toBe(0);
  });

  it('KSP3: fresh group → not deleted', () => {
    addScan('Fresh doc', 1);
    const result = getScanHistory().pruneStaleGroups(30);
    expect(result.deletedGroups).toBe(0);
    expect(result.deletedEntries).toBe(0);
    expect(getScanHistory().size).toBe(1);
  });

  it('KSP4: stale group with multiple entries — all entries for that group deleted', () => {
    addScan('Old text', 40); // scan 1
    addScan('Old text', 35); // scan 2 — still stale (most recent is 35d)
    expect(getScanHistory().size).toBe(2);

    const result = getScanHistory().pruneStaleGroups(30);
    expect(result.deletedGroups).toBe(1);
    expect(result.deletedEntries).toBe(2);
    expect(getScanHistory().size).toBe(0);
  });

  it('KSP5: mixed stale and fresh groups — only stale group removed', () => {
    addScan('Stale', 31);
    addScan('Fresh', 1);
    expect(getScanHistory().size).toBe(2);

    const result = getScanHistory().pruneStaleGroups(30);
    expect(result.deletedGroups).toBe(1);
    expect(result.deletedEntries).toBe(1);
    expect(getScanHistory().size).toBe(1);
    // Fresh doc remains
    expect(getScanHistory().getRecent(10)[0].textHash).toBe(hashText('Fresh'));
  });
});

// ── HTTP endpoint tests ──────────────────────────────────────────────────────

describe('DELETE /scans/stale — HTTP', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    process.env.FAULTLINE_API_KEY = ADMIN_KEY;
    resetKeyStore();
    resetScanHistory();
    resetAuditLogger();
    resetAnalytics();
    resetCache();
    resetCircuitBreaker();
    getKeyStore().create('Prune-Test Key');
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('KSP6: stale entries present → 200 with deletedGroups and deletedEntries', async () => {
    addScan('Doc A', 31);
    addScan('Doc B', 45);

    const res = await server.inject({ method: 'DELETE', url: '/scans/stale', headers: adminHeader() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deletedGroups).toBe(2);
    expect(body.deletedEntries).toBe(2);
    expect(body.days).toBe(30);
  });

  it('KSP7: empty history → 200 with zero counts', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/scans/stale', headers: adminHeader() });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.deletedGroups).toBe(0);
    expect(body.deletedEntries).toBe(0);
  });

  it('KSP8: ?days=7 — uses 7-day threshold', async () => {
    addScan('Week old', 8);   // stale at 7d
    addScan('Very old', 60);  // also stale
    addScan('Fresh', 1);      // not stale

    const res = await server.inject({ method: 'DELETE', url: '/scans/stale?days=7', headers: adminHeader() });
    const body = JSON.parse(res.body);
    expect(body.days).toBe(7);
    expect(body.deletedGroups).toBe(2);
  });

  it('KSP9: stale entries actually removed from history', async () => {
    addScan('Stale', 31);
    expect(getScanHistory().size).toBe(1);

    await server.inject({ method: 'DELETE', url: '/scans/stale', headers: adminHeader() });
    expect(getScanHistory().size).toBe(0);
  });

  it('KSP10: fresh entries remain after prune', async () => {
    addScan('Stale', 31);
    addScan('Fresh', 1);

    await server.inject({ method: 'DELETE', url: '/scans/stale', headers: adminHeader() });
    expect(getScanHistory().size).toBe(1);
    expect(getScanHistory().getRecent(1)[0].textHash).toBe(hashText('Fresh'));
  });

  it('KSP11: 403 without admin key', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/scans/stale' });
    expect(res.statusCode).toBe(403);
  });

  it('KSP12: group with multiple entries — all pruned together', async () => {
    addScan('Repeat', 50);
    addScan('Repeat', 45);
    addScan('Repeat', 40); // 3 scans, all stale
    addScan('Fresh', 0);

    const res = await server.inject({ method: 'DELETE', url: '/scans/stale', headers: adminHeader() });
    const body = JSON.parse(res.body);
    expect(body.deletedGroups).toBe(1);
    expect(body.deletedEntries).toBe(3);
    expect(getScanHistory().size).toBe(1); // Fresh remains
  });

  it('KSP13: days clamped to 365 maximum', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/scans/stale?days=99999', headers: adminHeader() });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).days).toBe(365);
  });

  it('KSP14: after prune, GET /scans/stale returns empty', async () => {
    addScan('Old', 31);

    await server.inject({ method: 'DELETE', url: '/scans/stale', headers: adminHeader() });

    const res = await server.inject({ method: 'GET', url: '/scans/stale', headers: adminHeader() });
    expect(JSON.parse(res.body).count).toBe(0);
  });

  it('KSP15: deletedGroups + deletedEntries counts accurate for multi-entry groups', async () => {
    addScan('GroupA', 35);
    addScan('GroupA', 32); // 2 entries in GroupA — both stale
    addScan('GroupB', 40); // 1 entry in GroupB — stale

    const res = await server.inject({ method: 'DELETE', url: '/scans/stale', headers: adminHeader() });
    const body = JSON.parse(res.body);
    expect(body.deletedGroups).toBe(2);
    expect(body.deletedEntries).toBe(3);
  });
});
