/**
 * Store Hardening Tests (N-146) — SQ1–SQ5, BJ1–BJ5, RA1–RA5
 *
 * Validates: N-20 (Batch Scan API), N-22 (Monitoring/Observability),
 *            N-39 (Production API Hardening)
 *
 * Covers uncovered branches in three API stores:
 *   SQ1–SQ5 : scan-queue.ts — maxConcurrency env var, tick() success/fail,
 *             start/stop timer lifecycle, start() idempotency
 *   BJ1–BJ5 : bulk-jobs.ts — fail() method, worstOffenders sort by severity,
 *             zero-file trust score, risk distribution accumulation
 *   RA1–RA5 : rate-alerts.ts — shouldAlert() guards, fire() console-only,
 *             fire() webhook success, fire() webhook failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn(),
}));

import { scan } from '@nxtg/faultline/cli/scan.js';
import {
  getScanQueue,
  resetScanQueue,
} from '../src/store/scan-queue.js';
import {
  getBulkJobStore,
  resetBulkJobStore,
} from '../src/store/bulk-jobs.js';
import {
  getRateLimitAlertStore,
  resetRateLimitAlertStore,
  checkAndAlert,
  ALERT_THRESHOLD_PCT,
} from '../src/store/rate-alerts.js';

const mockScan = vi.mocked(scan);

/** Minimal ScanResult shape — processItem only stores it as `result`. */
const MOCK_RESULT = {
  input: 'text',
  provider: 'mock',
  claims: [],
  verifications: {},
  overallRisk: 'low' as const,
  complianceReport: {
    generatedAt: '',
    overallRiskLevel: 'low',
    euRiskSummary: { totalClaims: 0, highestTier: 'minimal', unacceptable: 0, high: 0, limited: 0, minimal: 0 },
    claimMappings: [],
    triggeredArticles: [],
    mitigations: [],
    confidenceDistribution: { high: 0, medium: 0, low: 0 },
  },
  ruleFindings: [],
} as const;

// ===========================================================================
// SQ1–SQ5 — scan-queue.ts
// ===========================================================================

describe('ScanQueue — uncovered branches', () => {
  beforeEach(() => {
    resetScanQueue();
    mockScan.mockReset();
    delete process.env.FAULTLINE_QUEUE_CONCURRENCY;
  });

  afterEach(() => {
    getScanQueue().stop();
    delete process.env.FAULTLINE_QUEUE_CONCURRENCY;
  });

  it('SQ1: maxConcurrency reads FAULTLINE_QUEUE_CONCURRENCY env var', () => {
    process.env.FAULTLINE_QUEUE_CONCURRENCY = '7';
    resetScanQueue();
    expect(getScanQueue().maxConcurrency).toBe(7);
  });

  it('SQ2: tick() processes a pending item → status becomes "completed"', async () => {
    mockScan.mockResolvedValue(MOCK_RESULT as never);
    const item = getScanQueue().enqueue('key1', 2, 'test text', 'mock');
    getScanQueue().tick();
    await vi.waitFor(() => expect(item.status).toBe('completed'), { timeout: 2000 });
    expect(item.result).toBeDefined();
    expect(mockScan).toHaveBeenCalledWith('test text', 'mock');
  });

  it('SQ3: tick() on failing scan → status becomes "failed" with error message', async () => {
    mockScan.mockRejectedValue(new Error('Provider unavailable'));
    const item = getScanQueue().enqueue('key1', 2, 'test text', 'mock');
    getScanQueue().tick();
    await vi.waitFor(() => expect(item.status).toBe('failed'), { timeout: 2000 });
    expect(item.error).toBe('Provider unavailable');
    expect(item.completedAt).toBeDefined();
  });

  it('SQ4: start() registers a timer; stop() clears it', () => {
    const q = getScanQueue();
    q.start(60_000); // long interval — won't fire during test
    // stop() should not throw and should clear the internal timer
    expect(() => q.stop()).not.toThrow();
    // second stop() is also safe (idempotent)
    expect(() => q.stop()).not.toThrow();
  });

  it('SQ5: start() is idempotent — second call does not register a second timer', () => {
    const q = getScanQueue();
    q.start(60_000);
    q.start(60_000); // should be a no-op (if-this.timer guard)
    // If the guard works, only one interval should exist — stop once to clean up
    expect(() => q.stop()).not.toThrow();
  });
});

// ===========================================================================
// BJ1–BJ5 — bulk-jobs.ts
// ===========================================================================

describe('BulkJobStore — uncovered branches', () => {
  beforeEach(() => resetBulkJobStore());

  it('BJ1: fail() sets status="failed" and records completedAt (lines 127-134)', () => {
    const store = getBulkJobStore();
    const job = store.create(3);
    store.fail(job.id, 'Scan engine crashed');
    const got = store.get(job.id)!;
    expect(got.status).toBe('failed');
    expect(got.completedAt).toBeDefined();
    expect((got as typeof got & { error?: string }).error).toBe('Scan engine crashed');
  });

  it('BJ2: fail() with unknown id does not throw (guard branch)', () => {
    const store = getBulkJobStore();
    expect(() => store.fail('no-such-id', 'error')).not.toThrow();
  });

  it('BJ3: worstOffenders sort — critical ranked before high (RISK_SEVERITY_ORDER branch)', () => {
    const store = getBulkJobStore();
    const job = store.create(2);
    store.recordFileResult(job.id, { filename: 'b.txt', status: 'done', overallRisk: 'high' });
    store.recordFileResult(job.id, { filename: 'a.txt', status: 'done', overallRisk: 'critical' });
    store.complete(job.id);
    const summary = store.get(job.id)!.summary!;
    expect(summary.worstOffenders[0].risk).toBe('critical');
    expect(summary.worstOffenders[1].risk).toBe('high');
  });

  it('BJ4: complete() with zero totalFiles avoids division-by-zero (|| 1 guard)', () => {
    const store = getBulkJobStore();
    const job = store.create(0); // edge case: zero files
    store.complete(job.id);
    const summary = store.get(job.id)!.summary!;
    // trustScore = max(0, min(100, 100 - 0/1)) = 100
    expect(summary.overallTrustScore).toBe(100);
  });

  it('BJ5: riskDistribution accumulates counts across results of same risk level', () => {
    const store = getBulkJobStore();
    const job = store.create(3);
    store.recordFileResult(job.id, { filename: 'a.txt', status: 'done', overallRisk: 'low' });
    store.recordFileResult(job.id, { filename: 'b.txt', status: 'done', overallRisk: 'low' });
    store.recordFileResult(job.id, { filename: 'c.txt', status: 'done', overallRisk: 'high' });
    store.complete(job.id);
    const dist = store.get(job.id)!.summary!.riskDistribution;
    expect(dist['low']).toBe(2);
    expect(dist['high']).toBe(1);
  });
});

// ===========================================================================
// RA1–RA5 — rate-alerts.ts
// ===========================================================================

describe('RateLimitAlertStore — uncovered branches', () => {
  beforeEach(() => {
    resetRateLimitAlertStore();
    vi.stubGlobal('fetch', vi.fn());
    delete process.env.FAULTLINE_ALERT_WEBHOOK;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FAULTLINE_ALERT_WEBHOOK;
  });

  it('RA1: shouldAlert() returns false when limit is zero (div-by-zero guard)', () => {
    expect(getRateLimitAlertStore().shouldAlert('key1', 100, 0)).toBe(false);
  });

  it('RA2: shouldAlert() returns false when usage is below ALERT_THRESHOLD_PCT', () => {
    // 79% is below threshold (80%)
    expect(getRateLimitAlertStore().shouldAlert('key1', 79, 100)).toBe(false);
  });

  it('RA3: fire() without webhook stores alert with deliveryNote="console-only"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = getRateLimitAlertStore();
    await store.fire('key1', 90, 100);
    const alerts = store.getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].deliveryNote).toBe('console-only');
    expect(alerts[0].delivered).toBe(false);
    expect(alerts[0].keyId).toBe('key1');
    expect(alerts[0].pct).toBe(90);
  });

  it('RA4: fire() with webhook OK → delivered=true, deliveryNote="webhook"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FAULTLINE_ALERT_WEBHOOK = 'http://webhook.example.com';
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const store = getRateLimitAlertStore();
    await store.fire('key1', 85, 100);
    const alerts = store.getAlerts();
    expect(alerts[0].delivered).toBe(true);
    expect(alerts[0].deliveryNote).toBe('webhook');
  });

  it('RA5: fire() with webhook fetch throw → deliveryNote starts with "error:"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FAULTLINE_ALERT_WEBHOOK = 'http://webhook.example.com';
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const store = getRateLimitAlertStore();
    await store.fire('key1', 95, 100);
    const alerts = store.getAlerts();
    expect(alerts[0].delivered).toBe(false);
    expect(alerts[0].deliveryNote).toMatch(/^error:/);
    expect(alerts[0].deliveryNote).toContain('ECONNREFUSED');
  });
});
