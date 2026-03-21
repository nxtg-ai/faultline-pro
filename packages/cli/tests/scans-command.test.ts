/**
 * N-100 — faultline scans CLI command
 *
 * KSC1–KSC5   scans-client formatters (pure unit — no fetch)
 * KSC6–KSC15  main(['scans', ...]) integration using vi.mock on scans-client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { main } from '../cli/index.js';
import {
  formatStaleList,
  formatScanUsage,
  type ScanEntry,
  type ScanUsageStat,
} from '../cli/scans-client.js';

// ── Formatter unit tests (no fetch) ─────────────────────────────────────────

const SAMPLE_SCAN: ScanEntry = {
  id:          'entry-001',
  textHash:    'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344',
  textPreview: 'Climate change is accelerating faster than predicted by models.',
  provider:    'gemini',
  overallRisk: 'Medium',
  claimCount:  3,
  latencyMs:   120,
  timestamp:   new Date(Date.now() - 35 * 86_400_000).toISOString(),
  keyId:       'k1',
};

const SAMPLE_STAT: ScanUsageStat = {
  textHash:         'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344',
  textPreview:      'Economic data shows growth in Q3.',
  scanCount:        4,
  firstScannedAt:   new Date(Date.now() - 60 * 86_400_000).toISOString(),
  lastScannedAt:    new Date(Date.now() - 2 * 86_400_000).toISOString(),
  daysSinceFirstScan: 60,
  daysSinceLastScan:  2,
  latestRisk:       'Low',
  riskDrifted:      false,
  providers:        ['gemini'],
  avgLatencyMs:     90,
  isStale:          false,
};

describe('scans-client formatters', () => {
  it('KSC1: formatStaleList — empty result shows no-stale message with threshold', () => {
    const out = formatStaleList({ days: 30, count: 0, scans: [] });
    expect(out).toContain('No stale scans');
    expect(out).toContain('30');
  });

  it('KSC2: formatStaleList — shows count and days in header', () => {
    const out = formatStaleList({ days: 30, count: 1, scans: [SAMPLE_SCAN] });
    expect(out).toContain('>30 days');
    expect(out).toContain('(1)');
  });

  it('KSC3: formatStaleList — shows 8-char hash prefix', () => {
    const out = formatStaleList({ days: 30, count: 1, scans: [SAMPLE_SCAN] });
    expect(out).toContain('aabbccdd');
    expect(out).not.toContain('11223344aabbccdd'); // full hash not shown
  });

  it('KSC4: formatStaleList — shows truncated preview text', () => {
    const out = formatStaleList({ days: 30, count: 1, scans: [SAMPLE_SCAN] });
    expect(out).toContain('Climate change');
  });

  it('KSC5: formatScanUsage — shows summary counts', () => {
    const out = formatScanUsage({
      staleDays: 30, total: 5, staleCount: 2, riskDriftedCount: 1,
      stats: [SAMPLE_STAT],
    });
    expect(out).toContain('Total documents:');
    expect(out).toContain('5');
    expect(out).toContain('Stale:');
    expect(out).toContain('2');
    expect(out).toContain('Risk drifted:');
    expect(out).toContain('1');
  });
});

// ── CLI integration tests (mock scans-client) ────────────────────────────────

vi.mock('../cli/scans-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/scans-client.js')>();
  return {
    ...actual,
    getStaleScans: vi.fn(),
    getScanUsage:  vi.fn(),
  };
});

const BASE_ARGS = ['scans', 'stale', '--api-key', 'test-key', '--api-url', 'http://localhost:3000'];

describe('faultline scans — CLI integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const client = await import('../cli/scans-client.js');
    vi.mocked(client.getStaleScans).mockResolvedValue({ days: 30, count: 1, scans: [SAMPLE_SCAN] });
    vi.mocked(client.getScanUsage).mockResolvedValue({
      staleDays: 30, total: 3, staleCount: 1, riskDriftedCount: 0,
      stats: [SAMPLE_STAT],
    });
  });

  it('KSC6: missing --api-key and env var → exitCode 1 with helpful message', async () => {
    const savedEnv = process.env.FAULTLINE_API_KEY;
    delete process.env.FAULTLINE_API_KEY;
    const { exitCode, output } = await main(['scans', 'stale', '--api-url', 'http://localhost:3000']);
    expect(exitCode).toBe(1);
    expect(output).toContain('api-key');
    process.env.FAULTLINE_API_KEY = savedEnv;
  });

  it('KSC7: scans stale — calls getStaleScans with default days=30', async () => {
    const client = await import('../cli/scans-client.js');
    const { exitCode } = await main(BASE_ARGS);
    expect(exitCode).toBe(0);
    expect(vi.mocked(client.getStaleScans)).toHaveBeenCalledWith('http://localhost:3000', 'test-key', 30);
  });

  it('KSC8: scans stale --days 7 — calls getStaleScans with days=7', async () => {
    const client = await import('../cli/scans-client.js');
    await main(['scans', 'stale', '--days', '7', '--api-key', 'test-key', '--api-url', 'http://localhost:3000']);
    expect(vi.mocked(client.getStaleScans)).toHaveBeenCalledWith('http://localhost:3000', 'test-key', 7);
  });

  it('KSC9: scans stale — exitCode 0 with formatted output showing hash and preview', async () => {
    const { exitCode, output } = await main(BASE_ARGS);
    expect(exitCode).toBe(0);
    expect(output).toContain('aabbccdd');
    expect(output).toContain('Climate change');
  });

  it('KSC10: getStaleScans returns error → exitCode 1 with error message', async () => {
    const client = await import('../cli/scans-client.js');
    vi.mocked(client.getStaleScans).mockResolvedValue({ days: 30, count: 0, scans: [], error: 'Unauthorized' });
    const { exitCode, output } = await main(BASE_ARGS);
    expect(exitCode).toBe(1);
    expect(output).toContain('Unauthorized');
  });

  it('KSC11: scans usage — calls getScanUsage with defaults (staleDays=30)', async () => {
    const client = await import('../cli/scans-client.js');
    const { exitCode } = await main(['scans', 'usage', '--api-key', 'test-key', '--api-url', 'http://localhost:3000']);
    expect(exitCode).toBe(0);
    expect(vi.mocked(client.getScanUsage)).toHaveBeenCalledWith('http://localhost:3000', 'test-key', 30);
  });

  it('KSC12: scans usage --staleDays 14 — passes staleDays=14 to getScanUsage', async () => {
    const client = await import('../cli/scans-client.js');
    await main(['scans', 'usage', '--staleDays', '14', '--api-key', 'test-key', '--api-url', 'http://localhost:3000']);
    expect(vi.mocked(client.getScanUsage)).toHaveBeenCalledWith('http://localhost:3000', 'test-key', 14);
  });

  it('KSC13: scans usage output shows total, stale, and drift counts', async () => {
    const { exitCode, output } = await main(['scans', 'usage', '--api-key', 'test-key', '--api-url', 'http://localhost:3000']);
    expect(exitCode).toBe(0);
    expect(output).toContain('Total documents');
    expect(output).toContain('Stale');
    expect(output).toContain('Risk drifted');
  });

  it('KSC14: FAULTLINE_API_KEY and FAULTLINE_API_URL env vars used as fallback', async () => {
    const client = await import('../cli/scans-client.js');
    process.env.FAULTLINE_API_KEY = 'env-key';
    process.env.FAULTLINE_API_URL = 'http://env-host:9000';
    await main(['scans', 'stale']);
    expect(vi.mocked(client.getStaleScans)).toHaveBeenCalledWith('http://env-host:9000', 'env-key', 30);
    delete process.env.FAULTLINE_API_KEY;
    delete process.env.FAULTLINE_API_URL;
  });

  it('KSC15: unknown scans subcommand → exitCode 1 with usage hint', async () => {
    const { exitCode, output } = await main(['scans', 'unknown-sub', '--api-key', 'test-key']);
    expect(exitCode).toBe(1);
    expect(output).toContain('Usage:');
    expect(output).toContain('scans stale');
    expect(output).toContain('scans usage');
  });
});
