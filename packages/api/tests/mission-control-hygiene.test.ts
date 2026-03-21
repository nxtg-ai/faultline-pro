/**
 * N-101 — Mission control scan hygiene signals
 *
 * KMH1–KMH9   GET /mission-control/status: new hygiene fields
 * KMH10–KMH15 GET /mission-control: HTML hygiene panel
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getScanHistory, resetScanHistory, hashText } from '../src/store/scan-history.js';
import { resetCache } from '../src/store/cache.js';
import { resetAuditLogger } from '../src/store/audit.js';
import type { FastifyInstance } from 'fastify';

function setup() {
  resetScanHistory();
  resetCache();
  resetAuditLogger();
}

function addScan(text: string, opts: { daysAgo?: number; risk?: string; provider?: string } = {}) {
  getScanHistory().record({
    textHash:    hashText(text),
    textPreview: text.slice(0, 100),
    provider:    opts.provider ?? 'mock',
    overallRisk: opts.risk ?? 'Low',
    claimCount:  2,
    latencyMs:   60,
    timestamp:   new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000).toISOString(),
    keyId:       'k1',
  });
}

// ── GET /mission-control/status hygiene fields ────────────────────────────────

describe('GET /mission-control/status — scan hygiene fields (N-101)', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('KMH1: scans.totalDocuments is present and numeric', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status' });
    const body = JSON.parse(res.body);
    expect(typeof body.scans.totalDocuments).toBe('number');
  });

  it('KMH2: scans.staleCount is present and numeric', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status' });
    const body = JSON.parse(res.body);
    expect(typeof body.scans.staleCount).toBe('number');
  });

  it('KMH3: scans.riskDriftedCount is present and numeric', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status' });
    const body = JSON.parse(res.body);
    expect(typeof body.scans.riskDriftedCount).toBe('number');
  });

  it('KMH4: all three hygiene counts are 0 on empty history', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control/status' });
    const body = JSON.parse(res.body);
    expect(body.scans.totalDocuments).toBe(0);
    expect(body.scans.staleCount).toBe(0);
    expect(body.scans.riskDriftedCount).toBe(0);
  });

  it('KMH5: totalDocuments reflects unique textHash groups', async () => {
    addScan('Document A', { daysAgo: 0 });
    addScan('Document A', { daysAgo: 1 }); // same text → same group
    addScan('Document B', { daysAgo: 0 }); // different text → new group
    const res = await server.inject({ method: 'GET', url: '/mission-control/status' });
    const body = JSON.parse(res.body);
    expect(body.scans.totalDocuments).toBe(2); // 2 groups, not 3 entries
  });

  it('KMH6: staleCount reflects documents whose most-recent scan is >30 days old', async () => {
    addScan('Old doc', { daysAgo: 31 });    // stale
    addScan('Fresh doc', { daysAgo: 1 });   // not stale
    const res = await server.inject({ method: 'GET', url: '/mission-control/status' });
    const body = JSON.parse(res.body);
    expect(body.scans.staleCount).toBe(1);
  });

  it('KMH7: re-scanning a stale document resets it to non-stale', async () => {
    addScan('Re-verified', { daysAgo: 40 }); // old scan
    addScan('Re-verified', { daysAgo: 0 });  // fresh re-scan — group is now fresh
    const res = await server.inject({ method: 'GET', url: '/mission-control/status' });
    const body = JSON.parse(res.body);
    expect(body.scans.staleCount).toBe(0);
  });

  it('KMH8: riskDriftedCount reflects documents with changed verdicts across scans', async () => {
    addScan('Drifted doc', { risk: 'Low',  daysAgo: 5 });
    addScan('Drifted doc', { risk: 'High', daysAgo: 0 });  // verdict changed → drift
    addScan('Stable doc',  { risk: 'Low',  daysAgo: 2 });
    addScan('Stable doc',  { risk: 'Low',  daysAgo: 0 });  // same verdict → no drift
    const res = await server.inject({ method: 'GET', url: '/mission-control/status' });
    const body = JSON.parse(res.body);
    expect(body.scans.riskDriftedCount).toBe(1);
  });

  it('KMH9: existing scans fields (today, last60s, riskCounts) still present (backward-compat)', async () => {
    addScan('Check doc');
    const res = await server.inject({ method: 'GET', url: '/mission-control/status' });
    const body = JSON.parse(res.body);
    expect(typeof body.scans.today).toBe('number');
    expect(typeof body.scans.last60s).toBe('number');
    expect(typeof body.scans.riskCounts).toBe('object');
  });
});

// ── GET /mission-control HTML hygiene panel ───────────────────────────────────

describe('GET /mission-control — Scan Hygiene HTML panel (N-101)', () => {
  let server: FastifyInstance;
  beforeEach(() => { setup(); server = buildServer(); });
  afterEach(async () => { await server.close(); });

  it('KMH10: HTML contains "Scan Hygiene" section heading', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control' });
    expect(res.body).toContain('Scan Hygiene');
  });

  it('KMH11: HTML contains hygiene-stats panel id', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control' });
    expect(res.body).toContain('hygiene-stats');
  });

  it('KMH12: HTML JS render references staleCount', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control' });
    expect(res.body).toContain('staleCount');
  });

  it('KMH13: HTML JS render references riskDriftedCount', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control' });
    expect(res.body).toContain('riskDriftedCount');
  });

  it('KMH14: HTML contains "Risk Drifted" label text', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control' });
    expect(res.body).toContain('Risk Drifted');
  });

  it('KMH15: HTML contains "Stale" label text', async () => {
    const res = await server.inject({ method: 'GET', url: '/mission-control' });
    expect(res.body).toContain('Stale');
  });
});
