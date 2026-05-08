/**
 * N-214: npm download metrics — faultline stats command
 * DIRECTIVE-NXTG-20260404-01
 *
 * Tests: fetchNpmDownloads, loadSnapshots, saveSnapshot, computeTrend,
 * renderStats, statsCommand (mocked fetch + mocked fs).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  fetchNpmDownloads,
  fetchDailyRange,
  loadSnapshots,
  saveSnapshot,
  computeTrend,
  renderStats,
  renderSparkline,
  statsCommand,
  type NpmDownloadPoint,
  type NpmSnapshot,
  type NpmDailyPoint,
} from '../cli/stats.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_POINT: NpmDownloadPoint = {
  downloads: 205,
  start: '2026-03-28',
  end: '2026-04-03',
  package: '@nxtg/faultline',
};

const MOCK_POINT_SDK: NpmDownloadPoint = {
  downloads: 42,
  start: '2026-03-28',
  end: '2026-04-03',
  package: '@nxtg/faultline-sdk',
};

function makeSnapshot(pkg: string, downloads: number, periodEnd: string): NpmSnapshot {
  return {
    recordedAt: new Date().toISOString(),
    package: pkg,
    downloads,
    periodStart: '2026-03-22',
    periodEnd,
  };
}

// ── fetchNpmDownloads ─────────────────────────────────────────────────────────

describe('fetchNpmDownloads', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ST-F1: returns NpmDownloadPoint on success', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => MOCK_POINT,
    } as Response);
    const result = await fetchNpmDownloads('@nxtg/faultline');
    expect(result.downloads).toBe(205);
    expect(result.package).toBe('@nxtg/faultline');
    expect(result.start).toBe('2026-03-28');
  });

  it('ST-F2: encodes scoped package names in URL', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => MOCK_POINT,
    } as Response);
    await fetchNpmDownloads('@nxtg/faultline');
    const calledUrl = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('%40nxtg%2Ffaultline');
  });

  it('ST-F3: throws on non-ok HTTP response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);
    await expect(fetchNpmDownloads('@nxtg/unknown')).rejects.toThrow(/404/);
  });

  it('ST-F4: throws on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network failure'));
    await expect(fetchNpmDownloads('@nxtg/faultline')).rejects.toThrow('network failure');
  });
});

// ── loadSnapshots ─────────────────────────────────────────────────────────────

describe('loadSnapshots', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'fl-stats-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('ST-L1: returns empty array when file does not exist', () => {
    const result = loadSnapshots(join(tmpDir, 'missing.json'));
    expect(result).toEqual([]);
  });

  it('ST-L2: parses valid JSON file', () => {
    const path = join(tmpDir, 'snaps.json');
    const snap = makeSnapshot('@nxtg/faultline', 100, '2026-03-28');
    require('node:fs').writeFileSync(path, JSON.stringify([snap]));
    const result = loadSnapshots(path);
    expect(result).toHaveLength(1);
    expect(result[0]!.downloads).toBe(100);
  });

  it('ST-L3: returns empty array for malformed JSON', () => {
    const path = join(tmpDir, 'bad.json');
    require('node:fs').writeFileSync(path, 'not json {{{');
    const result = loadSnapshots(path);
    expect(result).toEqual([]);
  });

  it('ST-L4: returns empty array if file contains non-array JSON', () => {
    const path = join(tmpDir, 'obj.json');
    require('node:fs').writeFileSync(path, JSON.stringify({ foo: 'bar' }));
    const result = loadSnapshots(path);
    expect(result).toEqual([]);
  });
});

// ── saveSnapshot ──────────────────────────────────────────────────────────────

describe('saveSnapshot', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'fl-stats-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('ST-S1: creates file and saves first snapshot', () => {
    const path = join(tmpDir, 'snaps.json');
    const snaps = saveSnapshot(path, MOCK_POINT);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.downloads).toBe(205);
    expect(snaps[0]!.package).toBe('@nxtg/faultline');
  });

  it('ST-S2: appends a second snapshot', () => {
    const path = join(tmpDir, 'snaps.json');
    saveSnapshot(path, MOCK_POINT);
    const point2: NpmDownloadPoint = { ...MOCK_POINT, downloads: 300, start: '2026-04-04', end: '2026-04-10' };
    const snaps = saveSnapshot(path, point2);
    expect(snaps).toHaveLength(2);
    expect(snaps[1]!.downloads).toBe(300);
  });

  it('ST-S3: deduplicates same package + same periodEnd', () => {
    const path = join(tmpDir, 'snaps.json');
    saveSnapshot(path, MOCK_POINT);
    // Same period, updated download count (re-run same week)
    const updated = { ...MOCK_POINT, downloads: 250 };
    const snaps = saveSnapshot(path, updated);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.downloads).toBe(250);
  });

  it('ST-S4: creates parent directory if missing', () => {
    const path = join(tmpDir, 'nested', 'dir', 'snaps.json');
    const snaps = saveSnapshot(path, MOCK_POINT);
    expect(snaps).toHaveLength(1);
    const raw = readFileSync(path, 'utf-8');
    expect(JSON.parse(raw)).toHaveLength(1);
  });

  it('ST-S5: stores both packages independently', () => {
    const path = join(tmpDir, 'snaps.json');
    saveSnapshot(path, MOCK_POINT);
    const snaps = saveSnapshot(path, MOCK_POINT_SDK);
    const faultline = snaps.filter(s => s.package === '@nxtg/faultline');
    const sdk = snaps.filter(s => s.package === '@nxtg/faultline-sdk');
    expect(faultline).toHaveLength(1);
    expect(sdk).toHaveLength(1);
  });

  it('ST-S6: trims to MAX_SNAPSHOTS (52) per package', () => {
    const path = join(tmpDir, 'snaps.json');
    // Save 53 distinct periods for the same package
    for (let i = 0; i < 53; i++) {
      const end = `2025-01-${String(i + 1).padStart(2, '0')}`;
      const point: NpmDownloadPoint = { ...MOCK_POINT, downloads: i + 1, start: end, end };
      saveSnapshot(path, point);
    }
    const snaps = loadSnapshots(path);
    const pkgSnaps = snaps.filter(s => s.package === '@nxtg/faultline');
    expect(pkgSnaps.length).toBe(52);
    // Oldest should be dropped (period 01, downloads=1 should not exist)
    expect(pkgSnaps[0]!.downloads).toBeGreaterThan(1);
  });
});

// ── computeTrend ──────────────────────────────────────────────────────────────

describe('computeTrend', () => {
  it('ST-T1: returns flat with fewer than 2 snapshots', () => {
    const snaps = [makeSnapshot('@nxtg/faultline', 100, '2026-03-28')];
    const t = computeTrend(snaps, '@nxtg/faultline');
    expect(t.direction).toBe('flat');
    expect(t.delta).toBe(0);
  });

  it('ST-T2: returns up when downloads increased', () => {
    const snaps = [
      makeSnapshot('@nxtg/faultline', 100, '2026-03-21'),
      makeSnapshot('@nxtg/faultline', 200, '2026-03-28'),
    ];
    const t = computeTrend(snaps, '@nxtg/faultline');
    expect(t.direction).toBe('up');
    expect(t.delta).toBe(100);
    expect(t.percentChange).toBe(100);
  });

  it('ST-T3: returns down when downloads decreased', () => {
    const snaps = [
      makeSnapshot('@nxtg/faultline', 200, '2026-03-21'),
      makeSnapshot('@nxtg/faultline', 150, '2026-03-28'),
    ];
    const t = computeTrend(snaps, '@nxtg/faultline');
    expect(t.direction).toBe('down');
    expect(t.delta).toBe(-50);
    expect(t.percentChange).toBe(-25);
  });

  it('ST-T4: returns flat when downloads are equal', () => {
    const snaps = [
      makeSnapshot('@nxtg/faultline', 100, '2026-03-21'),
      makeSnapshot('@nxtg/faultline', 100, '2026-03-28'),
    ];
    const t = computeTrend(snaps, '@nxtg/faultline');
    expect(t.direction).toBe('flat');
    expect(t.delta).toBe(0);
  });

  it('ST-T5: uses only the most recent two snapshots', () => {
    const snaps = [
      makeSnapshot('@nxtg/faultline', 50,  '2026-03-07'),
      makeSnapshot('@nxtg/faultline', 100, '2026-03-14'),
      makeSnapshot('@nxtg/faultline', 200, '2026-03-21'),
      makeSnapshot('@nxtg/faultline', 150, '2026-03-28'),
    ];
    const t = computeTrend(snaps, '@nxtg/faultline');
    // latest=150, prev=200 → down 50
    expect(t.direction).toBe('down');
    expect(t.delta).toBe(-50);
  });

  it('ST-T6: filters by package name (ignores other packages)', () => {
    const snaps = [
      makeSnapshot('@nxtg/faultline-sdk', 500, '2026-03-21'),
      makeSnapshot('@nxtg/faultline-sdk', 600, '2026-03-28'),
      makeSnapshot('@nxtg/faultline', 100, '2026-03-28'),
    ];
    // @nxtg/faultline has only 1 snapshot → flat
    const t = computeTrend(snaps, '@nxtg/faultline');
    expect(t.direction).toBe('flat');
  });

  it('ST-T7: handles previous.downloads === 0 without dividing by zero', () => {
    const snaps = [
      makeSnapshot('@nxtg/faultline', 0,   '2026-03-21'),
      makeSnapshot('@nxtg/faultline', 100, '2026-03-28'),
    ];
    const t = computeTrend(snaps, '@nxtg/faultline');
    expect(t.direction).toBe('up');
    expect(t.percentChange).toBe(0); // 0-previous edge: percentChange stays 0
  });
});

// ── renderStats ───────────────────────────────────────────────────────────────

describe('renderStats', () => {
  it('ST-R1: includes the package name', () => {
    const output = renderStats([MOCK_POINT], []);
    expect(output).toContain('@nxtg/faultline');
  });

  it('ST-R2: includes download count', () => {
    const output = renderStats([MOCK_POINT], []);
    expect(output).toContain('205');
  });

  it('ST-R3: includes period dates', () => {
    const output = renderStats([MOCK_POINT], []);
    expect(output).toContain('2026-03-28');
    expect(output).toContain('2026-04-03');
  });

  it('ST-R4: shows TOTAL row summing all packages', () => {
    const output = renderStats([MOCK_POINT, MOCK_POINT_SDK], []);
    expect(output).toContain('TOTAL');
    expect(output).toContain('247'); // 205 + 42
  });

  it('ST-R5: shows trend arrow when history exists', () => {
    const snaps = [
      makeSnapshot('@nxtg/faultline', 100, '2026-03-21'),
      makeSnapshot('@nxtg/faultline', 205, '2026-04-03'),
    ];
    const output = renderStats([MOCK_POINT], snaps);
    expect(output).toMatch(/▲|\+105/);
  });

  it('ST-R6: shows snapshot history count', () => {
    const snaps = [
      makeSnapshot('@nxtg/faultline', 100, '2026-03-21'),
      makeSnapshot('@nxtg/faultline', 205, '2026-04-03'),
    ];
    const output = renderStats([MOCK_POINT], snaps);
    expect(output).toContain('Snapshot history');
  });
});

// ── statsCommand ──────────────────────────────────────────────────────────────

describe('statsCommand', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fl-stats-'));
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('ST-C1: exits 0 and returns download data on success', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => MOCK_POINT,
    } as Response);
    const result = await statsCommand({
      packages: ['@nxtg/faultline'],
      snapshotPath: join(tmpDir, 'snaps.json'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('205');
    expect(result.output).toContain('@nxtg/faultline');
  });

  it('ST-C2: persists a snapshot file after successful fetch', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => MOCK_POINT,
    } as Response);
    const snapshotPath = join(tmpDir, 'snaps.json');
    await statsCommand({ packages: ['@nxtg/faultline'], snapshotPath });
    const snaps = loadSnapshots(snapshotPath);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.downloads).toBe(205);
  });

  it('ST-C3: exits 1 when all packages fail to fetch', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));
    const result = await statsCommand({
      packages: ['@nxtg/faultline'],
      snapshotPath: join(tmpDir, 'snaps.json'),
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Failed');
  });

  it('ST-C4: partial success — shows data for successful packages + warning for failed', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_POINT } as Response)
      .mockRejectedValueOnce(new Error('timeout'));
    const result = await statsCommand({
      packages: ['@nxtg/faultline', '@nxtg/faultline-sdk'],
      snapshotPath: join(tmpDir, 'snaps.json'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('205');
    expect(result.output).toContain('Warnings');
  });

  it('ST-C5: --no-save skips writing snapshot file', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => MOCK_POINT,
    } as Response);
    const snapshotPath = join(tmpDir, 'snaps.json');
    await statsCommand({ packages: ['@nxtg/faultline'], snapshotPath, noSave: true });
    expect(require('node:fs').existsSync(snapshotPath)).toBe(false);
  });

  it('ST-C6: shows trend when prior snapshot exists', async () => {
    // Pre-populate one snapshot
    const snapshotPath = join(tmpDir, 'snaps.json');
    saveSnapshot(snapshotPath, { ...MOCK_POINT, downloads: 100, start: '2026-03-21', end: '2026-03-27' });

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => MOCK_POINT,
    } as Response);
    const result = await statsCommand({ packages: ['@nxtg/faultline'], snapshotPath });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/▲|\+105/);
  });
});

// ── fetchDailyRange ───────────────────────────────────────────────────────────

const MOCK_RANGE_RESPONSE = {
  start: '2026-03-30',
  end: '2026-04-28',
  package: '@nxtg/faultline',
  downloads: [
    { day: '2026-03-30', downloads: 10 },
    { day: '2026-03-31', downloads: 15 },
    { day: '2026-04-01', downloads: 20 },
  ] as NpmDailyPoint[],
};

describe('fetchDailyRange', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('ST-DR1: returns range response on success', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => MOCK_RANGE_RESPONSE,
    } as Response);
    const result = await fetchDailyRange('@nxtg/faultline', 30);
    expect(result.downloads).toHaveLength(3);
    expect(result.downloads[0]!.day).toBe('2026-03-30');
    expect(result.downloads[2]!.downloads).toBe(20);
  });

  it('ST-DR2: URL uses range API with date range', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => MOCK_RANGE_RESPONSE,
    } as Response);
    await fetchDailyRange('@nxtg/faultline', 30);
    const url = vi.mocked(fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('downloads/range');
    expect(url).toContain('%40nxtg%2Ffaultline');
  });

  it('ST-DR3: throws on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found',
    } as Response);
    await expect(fetchDailyRange('@nxtg/faultline', 30)).rejects.toThrow(/404/);
  });

  it('ST-DR4: throws on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));
    await expect(fetchDailyRange('@nxtg/faultline', 30)).rejects.toThrow('network down');
  });
});

// ── renderSparkline ───────────────────────────────────────────────────────────

describe('renderSparkline', () => {
  it('ST-SP1: returns fallback string for empty input', () => {
    const result = renderSparkline([]);
    expect(result.length).toBeGreaterThan(0);
    // Either dashes or "(no data)" — both valid fallbacks
    expect(result).toMatch(/^[─(].*/);
  });

  it('ST-SP2: length equals width parameter', () => {
    const points: NpmDailyPoint[] = Array.from({ length: 30 }, (_, i) => ({ day: `2026-04-${String(i + 1).padStart(2, '0')}`, downloads: i * 10 }));
    const result = renderSparkline(points, 20);
    expect([...result].length).toBe(20);
  });

  it('ST-SP3: uses block characters', () => {
    const points: NpmDailyPoint[] = [
      { day: '2026-04-01', downloads: 0 },
      { day: '2026-04-02', downloads: 100 },
    ];
    const result = renderSparkline(points);
    expect(result).toMatch(/[▁▂▃▄▅▆▇█]/);
  });

  it('ST-SP4: single data point renders as max block', () => {
    const result = renderSparkline([{ day: '2026-04-01', downloads: 100 }]);
    expect(result).toContain('█');
  });

  it('ST-SP5: all-zero downloads renders as all first-bar', () => {
    const points: NpmDailyPoint[] = Array.from({ length: 5 }, (_, i) => ({ day: `2026-04-0${i + 1}`, downloads: 0 }));
    const result = renderSparkline(points, 5);
    expect(result).not.toContain('█');
  });

  it('ST-SP6: does not render more than width characters', () => {
    const points: NpmDailyPoint[] = Array.from({ length: 50 }, (_, i) => ({ day: `2026-03-${String(i + 1).padStart(2, '0')}`, downloads: i }));
    const result = renderSparkline(points, 28);
    expect([...result].length).toBeLessThanOrEqual(28);
  });
});

// ── statsCommand — daily trend ────────────────────────────────────────────────

describe('statsCommand — daily trend', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fl-stats-'));
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('ST-DT1: daily trend appears in output when fetchDailyRange succeeds', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_POINT } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_RANGE_RESPONSE } as Response);
    const result = await statsCommand({
      packages: ['@nxtg/faultline'],
      snapshotPath: join(tmpDir, 'snaps.json'),
      dailyTrend: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('30-DAY DAILY TREND');
  });

  it('ST-DT2: sparkline appears in trend section', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_POINT } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_RANGE_RESPONSE } as Response);
    const result = await statsCommand({
      packages: ['@nxtg/faultline'],
      snapshotPath: join(tmpDir, 'snaps.json'),
      dailyTrend: true,
    });
    expect(result.output).toContain('Sparkline:');
  });

  it('ST-DT3: daily trend failure is non-fatal (weekly stats still shown)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_POINT } as Response)
      .mockRejectedValueOnce(new Error('range API down'));
    const result = await statsCommand({
      packages: ['@nxtg/faultline'],
      snapshotPath: join(tmpDir, 'snaps.json'),
      dailyTrend: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('205'); // weekly stats still present
  });

  it('ST-DT4: dailyTrend:false skips range fetch', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true, json: async () => MOCK_POINT,
    } as Response);
    await statsCommand({
      packages: ['@nxtg/faultline'],
      snapshotPath: join(tmpDir, 'snaps.json'),
      dailyTrend: false,
    });
    // Only 1 fetch call (the weekly point), not 2
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

// ── CLI integration ───────────────────────────────────────────────────────────

describe('CLI: faultline stats', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ST-I1: main(["stats"]) routes to statsCommand', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => MOCK_POINT,
    } as Response);
    const { main } = await import('../cli/index.js');
    const result = await main(['stats', '--no-save']);
    // If fetch is called we know routing worked; exitCode 0 = success
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('@nxtg/faultline');
  });

  it('ST-I2: main(["stats", "--costs"]) preserves api-url and api-key flags', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ p50: 0.0001, p90: 0.0002, p99: 0.0003, count: 12, windowDays: 30 }),
    } as Response);
    const { main } = await import('../cli/index.js');
    const result = await main(['stats', '--costs', '--api-url', 'http://faultline.test', '--api-key', 'test-key']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('SCAN COST STATS');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://faultline.test/costs/percentiles?days=30',
      expect.objectContaining({ headers: { 'x-api-key': 'test-key' } }),
    );
  });

  it('ST-I3: trailing --no-save is parsed as boolean and skips snapshot writes', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fl-stats-cli-'));
    try {
      const snapshotPath = join(tmpDir, 'snapshots.json');
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => MOCK_POINT,
      } as Response);
      const { main } = await import('../cli/index.js');
      const result = await main(['stats', '--snapshot-path', snapshotPath, '--no-save']);
      expect(result.exitCode).toBe(0);
      expect(existsSync(snapshotPath)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
