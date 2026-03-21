/**
 * N-107 — faultline scans prune CLI
 *
 * SP1–SP5   formatScansPrunePreview: empty result, single group, multiple groups,
 *           --confirm hint present, day count correct.
 * SP6–SP8   formatScansPruneResult: error passthrough, zero deleted, one group,
 *           plural form.
 * SP9–SP12  pruneScans HTTP: calls DELETE /scans/stale, passes days in query,
 *           maps deletedGroups/deletedEntries, propagates error.
 * SP13–SP15 CLI integration via main(): dry-run default, --confirm executes,
 *           missing api-key returns exit 1.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getScansPrunePreview,
  pruneScans,
  formatScansPrunePreview,
  formatScansPruneResult,
} from '../cli/scans-client.js';
import type { StaleScanResult, ScansPruneResult } from '../cli/scans-client.js';
import { main } from '../cli/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStaleScan(overrides: Partial<{
  id: string; textHash: string; textPreview: string; provider: string;
  overallRisk: string; claimCount: number; latencyMs: number; timestamp: string; keyId: string;
}> = {}) {
  return {
    id:          overrides.id          ?? 'scan-id-1',
    textHash:    overrides.textHash    ?? 'abcdef1234567890',
    textPreview: overrides.textPreview ?? 'The Eiffel Tower is 330 metres tall',
    provider:    overrides.provider    ?? 'gemini',
    overallRisk: overrides.overallRisk ?? 'low',
    claimCount:  overrides.claimCount  ?? 2,
    latencyMs:   overrides.latencyMs   ?? 120,
    timestamp:   overrides.timestamp   ?? new Date(Date.now() - 40 * 86_400_000).toISOString(),
    keyId:       overrides.keyId       ?? 'key-1',
  };
}

function makeStaleResult(overrides: Partial<StaleScanResult> = {}): StaleScanResult {
  return {
    days:  overrides.days  ?? 30,
    count: overrides.count ?? 0,
    scans: overrides.scans ?? [],
    error: overrides.error,
  };
}

// ── formatScansPrunePreview ───────────────────────────────────────────────────

describe('formatScansPrunePreview', () => {
  it('SP1: empty result returns nothing-to-prune message', () => {
    const out = formatScansPrunePreview(makeStaleResult({ days: 30, count: 0, scans: [] }));
    expect(out).toContain('Nothing to prune');
    expect(out).toContain('30');
  });

  it('SP2: single group shows DRY RUN header and document hash', () => {
    const scan = makeStaleScan({ textHash: 'aabbccdd11223344' });
    const out = formatScansPrunePreview(makeStaleResult({ days: 30, count: 1, scans: [scan] }));
    expect(out).toContain('DRY RUN');
    expect(out).toContain('aabbccdd');
  });

  it('SP3: multiple groups shows correct count', () => {
    const scans = [
      makeStaleScan({ id: 's1', textHash: 'hash1111aaaa0000' }),
      makeStaleScan({ id: 's2', textHash: 'hash2222bbbb0000' }),
      makeStaleScan({ id: 's3', textHash: 'hash3333cccc0000' }),
    ];
    const out = formatScansPrunePreview(makeStaleResult({ days: 30, count: 3, scans }));
    expect(out).toContain('3 stale document group');
    expect(out).toContain('hash1111');
    expect(out).toContain('hash2222');
    expect(out).toContain('hash3333');
  });

  it('SP4: output includes --confirm hint', () => {
    const scan = makeStaleScan();
    const out = formatScansPrunePreview(makeStaleResult({ days: 30, count: 1, scans: [scan] }));
    expect(out).toContain('--confirm');
  });

  it('SP5: days threshold shown in header', () => {
    const scan = makeStaleScan();
    const out = formatScansPrunePreview(makeStaleResult({ days: 45, count: 1, scans: [scan] }));
    expect(out).toContain('45');
  });
});

// ── formatScansPruneResult ────────────────────────────────────────────────────

describe('formatScansPruneResult', () => {
  it('SP6: error field is returned as error message', () => {
    const result: ScansPruneResult = { days: 30, deletedGroups: 0, deletedEntries: 0, error: 'Unauthorized' };
    const out = formatScansPruneResult(result);
    expect(out).toContain('Error: Unauthorized');
  });

  it('SP7: zero deletedGroups returns nothing-pruned message', () => {
    const result: ScansPruneResult = { days: 30, deletedGroups: 0, deletedEntries: 0 };
    const out = formatScansPruneResult(result);
    expect(out).toContain('Nothing pruned');
  });

  it('SP8: single group uses singular form and shows entry count', () => {
    const result: ScansPruneResult = { days: 30, deletedGroups: 1, deletedEntries: 5 };
    const out = formatScansPruneResult(result);
    expect(out).toContain('1 document group');
    expect(out).toContain('5 scan entries');
    expect(out).not.toContain('groups');
  });

  it('SP8b: multiple groups uses plural form', () => {
    const result: ScansPruneResult = { days: 30, deletedGroups: 3, deletedEntries: 12 };
    const out = formatScansPruneResult(result);
    expect(out).toContain('3 document groups');
    expect(out).toContain('12 scan entries');
  });
});

// ── pruneScans HTTP client ─────────────────────────────────────────────────────

describe('pruneScans', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('SP9: calls DELETE /scans/stale with days query param', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ deletedGroups: 2, deletedEntries: 8 }), { status: 200 }));
    await pruneScans('http://localhost:3000', 'key-x', 45);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('http://localhost:3000/scans/stale?days=45');
    expect((opts as RequestInit).method).toBe('DELETE');
  });

  it('SP10: maps deletedGroups and deletedEntries from response', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ deletedGroups: 3, deletedEntries: 15 }), { status: 200 }));
    const result = await pruneScans('http://localhost:3000', 'key-x', 30);
    expect(result.deletedGroups).toBe(3);
    expect(result.deletedEntries).toBe(15);
    expect(result.days).toBe(30);
  });

  it('SP11: server error is propagated as result.error', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }));
    const result = await pruneScans('http://localhost:3000', 'bad-key', 30);
    expect(result.error).toBeTruthy();
    expect(result.deletedGroups).toBe(0);
  });

  it('SP12: getScansPrunePreview calls GET /scans/stale (read-only)', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ days: 30, count: 0, scans: [] }), { status: 200 }));
    await getScansPrunePreview('http://localhost:3000', 'key-x', 30);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/scans/stale');
    // GET, not DELETE
    expect((opts as RequestInit | undefined)?.method).toBeUndefined();
  });
});

// ── CLI integration ───────────────────────────────────────────────────────────

describe('faultline scans prune — CLI integration', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('SP13: dry-run by default — calls GET, outputs DRY RUN header', async () => {
    const mockFetch = vi.mocked(fetch);
    const scan = makeStaleScan({ textHash: 'dryrunhash000001' });
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ days: 30, count: 1, scans: [scan] }), { status: 200 }));

    const result = await main(['scans', 'prune', '--days', '30', '--api-key', 'test-key']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('DRY RUN');
    expect(result.output).toContain('dryrunh');

    // Must NOT have called DELETE
    const deleteCalls = (mockFetch.mock.calls as Array<[string | URL, RequestInit | undefined]>)
      .filter(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCalls).toHaveLength(0);
  });

  it('SP14: --confirm flag executes DELETE and shows pruned count', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ deletedGroups: 2, deletedEntries: 9 }), { status: 200 }));

    const result = await main(['scans', 'prune', '--days', '30', '--confirm', '--api-key', 'test-key']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('2');
    expect(result.output).toContain('9');
  });

  it('SP15: missing api-key returns exit code 1', async () => {
    const original = process.env.FAULTLINE_API_KEY;
    delete process.env.FAULTLINE_API_KEY;
    const result = await main(['scans', 'prune', '--days', '30']);
    process.env.FAULTLINE_API_KEY = original;
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('api-key');
  });
});
