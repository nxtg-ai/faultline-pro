/**
 * Scan Store Hardening Tests (N-151) — SS1–SS10
 *
 * Validates: N-48 (Scan History Search), N-63 (Scan Timeline)
 *
 * Covers uncovered branches in two modules:
 *   SS1–SS4 : store/scans.ts — reset() instance method (lines 37-39),
 *              size getter (lines 41-43), record() overflow eviction
 *              (line 24 if-branch), list() without keyId (line 29 false-branch)
 *   SS5–SS8 : routes/scans.ts — GET /scans/timeline ?limit= branch (line 32),
 *              parseInt NaN || 50 fallback (line 32), GET /scans/search
 *              ?limit= branch (line 261), GET /scans/stale/view
 *              riskColour() default ?? '#6b7280' (line 112)
 *   SS9–SS10: store/scans.ts — list() keyId filter + getScanStore() singleton
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import { getScanStore, resetScanStore } from '../src/store/scans.js';
import { getScanHistory, resetScanHistory } from '../src/store/scan-history.js';
import type { FastifyInstance } from 'fastify';

// ===========================================================================
// SS1–SS4 — store/scans.ts uncovered branches
// ===========================================================================

describe('ScanStore — uncovered branches (store/scans.ts)', () => {
  beforeEach(() => resetScanStore());

  it('SS1: reset() instance method clears scans array (lines 37-39)', () => {
    const store = getScanStore();
    store.record('k1', 'text a', { result: 1 });
    store.record('k1', 'text b', { result: 2 });
    expect(store.list()).toHaveLength(2);

    store.reset(); // instance method — not resetScanStore()

    expect(store.list()).toHaveLength(0);
  });

  it('SS2: size getter returns correct count after records (lines 41-43)', () => {
    const store = getScanStore();
    expect(store.size).toBe(0);
    store.record('k1', 'text a', {});
    store.record('k1', 'text b', {});
    expect(store.size).toBe(2);
  });

  it('SS3: record() overflow eviction — 1001st record evicts oldest (line 24 if-branch)', () => {
    const store = getScanStore();
    // Fill to MAX (1000) + 1 to trigger shift()
    for (let i = 0; i < 1001; i++) {
      store.record('k1', `text-${i}`, { index: i });
    }
    // Still capped at 1000
    expect(store.size).toBe(1000);
    // First entry (text-0) should be gone — oldest evicted
    const all = store.list(undefined, 1000);
    expect(all.some((s) => s.text === 'text-0')).toBe(false);
    expect(all.some((s) => s.text === 'text-1000')).toBe(true);
  });

  it('SS4: list() without keyId returns all scans (line 29 false-branch)', () => {
    const store = getScanStore();
    store.record('key-a', 'text for a', {});
    store.record('key-b', 'text for b', {});

    const all = store.list(); // no keyId → returns all
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((s) => s.keyId === 'key-a')).toBe(true);
    expect(all.some((s) => s.keyId === 'key-b')).toBe(true);
  });
});

// ===========================================================================
// SS5–SS8 — routes/scans.ts uncovered branches
// ===========================================================================

describe('GET /scans/timeline — limit param branches (routes/scans.ts line 32)', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetScanHistory();
    process.env.FAULTLINE_API_KEY = 'admin-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('SS5: ?limit=3 — limit truthy branch → Math.min(3, 200) = 3 (line 32)', async () => {
    // Seed 5 entries for the same text hash
    for (let i = 0; i < 5; i++) {
      getScanHistory().record({
        textHash: 'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd',
        textPreview: 'test document',
        provider: 'mock',
        overallRisk: 'low',
        claimCount: i,
        latencyMs: 50,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        keyId: 'k1',
      });
    }

    const res = await server.inject({
      method: 'GET',
      url: '/scans/timeline?text_hash=aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd&limit=3',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // limit=3 is respected
    expect(body.timeline.length).toBeLessThanOrEqual(3);
  });

  it('SS6: ?limit=abc — parseInt NaN → || 50 fallback (line 32)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/scans/timeline?text_hash=deadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000&limit=abc',
      headers: { 'x-api-key': 'admin-key' },
    });
    // NaN || 50 gives 50 — request succeeds, empty timeline
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).timeline).toHaveLength(0);
  });
});

describe('GET /scans/search — limit param branch (routes/scans.ts line 261)', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetScanHistory();
    process.env.FAULTLINE_API_KEY = 'admin-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('SS7: ?limit=5 — limit truthy branch → Math.min(5, 100) = 5 (line 261)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/scans/search?limit=5',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Response is valid; limit branch was exercised
    expect(Array.isArray(body.scans)).toBe(true);
    expect(body.total).toBe(0); // no data seeded
  });
});

describe('GET /scans/stale/view — riskColour() default branch (routes/scans.ts line 112)', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetScanHistory();
    process.env.FAULTLINE_API_KEY = 'admin-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('SS8: entry with unrecognised risk hits riskColour() ?? "#6b7280" default (line 112)', async () => {
    // Back-date timestamp so it appears stale (> 30 days ago)
    const staleTs = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    getScanHistory().record({
      textHash: 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe',
      textPreview: 'document with unusual risk',
      provider: 'mock',
      overallRisk: 'unusual', // NOT in {Critical, High, Medium, Low} → hits ?? '#6b7280'
      claimCount: 1,
      latencyMs: 30,
      timestamp: staleTs,
      keyId: 'k1',
    });

    const res = await server.inject({
      method: 'GET',
      url: '/scans/stale/view',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    // The fallback colour should appear in the rendered HTML
    expect(res.body).toContain('#6b7280');
  });
});

// ===========================================================================
// SS9–SS10 — store/scans.ts remaining branches
// ===========================================================================

describe('ScanStore — remaining branches', () => {
  beforeEach(() => resetScanStore());

  it('SS9: list(keyId) filters by keyId — only matching entries returned', () => {
    const store = getScanStore();
    store.record('key-a', 'text for a', {});
    store.record('key-b', 'text for b', {});

    const filtered = store.list('key-a');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.keyId).toBe('key-a');
  });

  it('SS10: getScanStore() returns singleton — same instance on second call', () => {
    const a = getScanStore();
    const b = getScanStore();
    expect(a).toBe(b);
  });
});
