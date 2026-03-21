/**
 * N-105 — Tenant-scoped scan history
 *
 * TSH1–TSH5   ScanEntry.tenantId field: stored in record(), undefined for un-tenanted,
 *             present in getRecent(), persists across reset cycle.
 * TSH6–TSH10  search() tenantId filter: returns only matching tenant's scans,
 *             no-filter returns all, combined with q filter, empty result, cross-tenant isolation.
 * TSH11–TSH13 getScanUsageStats() tenantId filter: per-tenant stat grouping,
 *             cross-tenant isolation, no-filter returns all.
 * TSH14–TSH15 getStaleScanGroups() tenantId filter: scoped stale detection,
 *             cross-tenant isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getScanHistory, resetScanHistory } from '../src/store/scan-history.js';

const DAY_MS = 86_400_000;

function agoMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function makeEntry(overrides: {
  textHash?: string;
  textPreview?: string;
  provider?: string;
  overallRisk?: string;
  claimCount?: number;
  latencyMs?: number;
  timestamp?: string;
  keyId?: string;
  tenantId?: string;
}) {
  return {
    textHash:    overrides.textHash    ?? 'hash-a',
    textPreview: overrides.textPreview ?? 'Sample text',
    provider:    overrides.provider    ?? 'mock',
    overallRisk: overrides.overallRisk ?? 'Low',
    claimCount:  overrides.claimCount  ?? 1,
    latencyMs:   overrides.latencyMs   ?? 100,
    timestamp:   overrides.timestamp   ?? new Date().toISOString(),
    keyId:       overrides.keyId       ?? 'key-1',
    tenantId:    overrides.tenantId,
  };
}

beforeEach(() => { resetScanHistory(); });

// ── ScanEntry.tenantId field ──────────────────────────────────────────────────

describe('ScanEntry.tenantId — storage', () => {
  it('TSH1: record() stores tenantId when provided', () => {
    const entry = getScanHistory().record(makeEntry({ tenantId: 'tenant-alpha' }));
    expect(entry.tenantId).toBe('tenant-alpha');
  });

  it('TSH2: record() stores undefined tenantId for un-tenanted key', () => {
    const entry = getScanHistory().record(makeEntry({ tenantId: undefined }));
    expect(entry.tenantId).toBeUndefined();
  });

  it('TSH3: tenantId survives getRecent()', () => {
    getScanHistory().record(makeEntry({ tenantId: 'tenant-beta' }));
    const recent = getScanHistory().getRecent(1);
    expect(recent[0].tenantId).toBe('tenant-beta');
  });

  it('TSH4: multiple tenantIds stored independently', () => {
    getScanHistory().record(makeEntry({ tenantId: 'tenant-a', textHash: 'hash-a', keyId: 'k1' }));
    getScanHistory().record(makeEntry({ tenantId: 'tenant-b', textHash: 'hash-b', keyId: 'k2' }));
    const recent = getScanHistory().getRecent(2);
    const tenantIds = recent.map((e) => e.tenantId);
    expect(tenantIds).toContain('tenant-a');
    expect(tenantIds).toContain('tenant-b');
  });

  it('TSH5: tenantId is present alongside keyId (both fields coexist)', () => {
    const entry = getScanHistory().record(makeEntry({ keyId: 'key-xyz', tenantId: 'tenant-xyz' }));
    expect(entry.keyId).toBe('key-xyz');
    expect(entry.tenantId).toBe('tenant-xyz');
  });
});

// ── search() tenantId filter ──────────────────────────────────────────────────

describe('search() — tenantId filter', () => {
  beforeEach(() => {
    getScanHistory().record(makeEntry({ tenantId: 'alpha', textHash: 'ha', textPreview: 'alpha doc' }));
    getScanHistory().record(makeEntry({ tenantId: 'beta',  textHash: 'hb', textPreview: 'beta doc'  }));
    getScanHistory().record(makeEntry({ tenantId: undefined, textHash: 'hc', textPreview: 'no tenant' }));
  });

  it('TSH6: tenantId filter returns only that tenant\'s scans', () => {
    const { entries } = getScanHistory().search({ tenantId: 'alpha' });
    expect(entries).toHaveLength(1);
    expect(entries[0].tenantId).toBe('alpha');
  });

  it('TSH7: no tenantId filter returns all scans', () => {
    const { entries } = getScanHistory().search({});
    expect(entries).toHaveLength(3);
  });

  it('TSH8: tenantId + q combined — returns only matching tenant with text match', () => {
    const { entries } = getScanHistory().search({ tenantId: 'beta', q: 'beta' });
    expect(entries).toHaveLength(1);
    expect(entries[0].textPreview).toBe('beta doc');
  });

  it('TSH9: tenantId filter with no matching tenant — empty result', () => {
    const { entries } = getScanHistory().search({ tenantId: 'nonexistent' });
    expect(entries).toHaveLength(0);
  });

  it('TSH10: cross-tenant isolation — alpha filter does not return beta scans', () => {
    const { entries } = getScanHistory().search({ tenantId: 'alpha' });
    expect(entries.every((e) => e.tenantId === 'alpha')).toBe(true);
    expect(entries.some((e) => e.tenantId === 'beta')).toBe(false);
  });
});

// ── getScanUsageStats() tenantId filter ───────────────────────────────────────

describe('getScanUsageStats() — tenantId filter', () => {
  beforeEach(() => {
    getScanHistory().record(makeEntry({ tenantId: 'alpha', textHash: 'ha1' }));
    getScanHistory().record(makeEntry({ tenantId: 'alpha', textHash: 'ha2' }));
    getScanHistory().record(makeEntry({ tenantId: 'beta',  textHash: 'hb1' }));
  });

  it('TSH11: tenantId filter returns only that tenant\'s textHash groups', () => {
    const stats = getScanHistory().getScanUsageStats(30, 'alpha');
    expect(stats).toHaveLength(2);
    expect(stats.every((s) => ['ha1', 'ha2'].includes(s.textHash))).toBe(true);
  });

  it('TSH12: cross-tenant isolation — beta stats do not appear in alpha query', () => {
    const stats = getScanHistory().getScanUsageStats(30, 'alpha');
    expect(stats.some((s) => s.textHash === 'hb1')).toBe(false);
  });

  it('TSH13: no tenantId filter returns all groups', () => {
    const stats = getScanHistory().getScanUsageStats(30);
    expect(stats).toHaveLength(3);
  });
});

// ── getStaleScanGroups() tenantId filter ──────────────────────────────────────

describe('getStaleScanGroups() — tenantId filter', () => {
  beforeEach(() => {
    const staleTs = agoMs(40 * DAY_MS);
    getScanHistory().record(makeEntry({ tenantId: 'alpha', textHash: 'ha-stale', timestamp: staleTs }));
    getScanHistory().record(makeEntry({ tenantId: 'beta',  textHash: 'hb-stale', timestamp: staleTs }));
  });

  it('TSH14: tenantId filter returns only that tenant\'s stale groups', () => {
    const stale = getScanHistory().getStaleScanGroups(30, 'alpha');
    expect(stale).toHaveLength(1);
    expect(stale[0].textHash).toBe('ha-stale');
  });

  it('TSH15: cross-tenant isolation — beta stale group not in alpha query', () => {
    const stale = getScanHistory().getStaleScanGroups(30, 'alpha');
    expect(stale.some((s) => s.textHash === 'hb-stale')).toBe(false);
  });
});
