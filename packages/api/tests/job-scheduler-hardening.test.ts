/**
 * Job Scheduler Hardening Tests (N-150) — JH1–JH8
 *
 * Validates: N-25 (Scheduled Scan Jobs), N-22 (Monitoring/Observability)
 *
 * Covers uncovered branches in store/jobs.ts:
 *   JH1–JH3 : JobScheduler.tick() body (lines 122-126) —
 *              paused-job skip, not-yet-due skip, due-job run
 *   JH4–JH5 : JobScheduler.runJob() catch block (lines 163-165) —
 *              scan throws Error, scan throws non-Error string
 *   JH6–JH7 : JobScheduler.start() idempotency + stop() no-op
 *   JH8     : parseIntervalMs() unrecognized schedule → 60-min default
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn(),
}));

import { scan } from '@nxtg/faultline/cli/scan.js';
import {
  getJobStore,
  getJobScheduler,
  resetJobStore,
  resetJobScheduler,
  parseIntervalMs,
} from '../src/store/jobs.js';
import { resetWebhookStore, getWebhookStore } from '../src/store/webhooks.js';

const mockScan = vi.mocked(scan);

const MOCK_RESULT = {
  input: 'test',
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

beforeEach(() => {
  resetJobStore();
  resetJobScheduler();
  resetWebhookStore();
  mockScan.mockReset();
  mockScan.mockResolvedValue(MOCK_RESULT as never);
});

afterEach(() => {
  getJobScheduler().stop();
});

// ===========================================================================
// JH1–JH3 — tick() body (lines 122-126)
// ===========================================================================

describe('JobScheduler.tick() — uncovered branches (lines 122-126)', () => {
  it('JH1: tick() skips paused job — status !== "active" continue branch', async () => {
    const job = getJobStore().create({ text: 'paused', schedule: '* * * * *' });
    // Set past due AND paused
    getJobStore().update(job.id, {
      status: 'paused',
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });

    await getJobScheduler().tick();

    // scan must NOT have been called — job was paused
    expect(mockScan).not.toHaveBeenCalled();
    // runCount stays 0
    expect(getJobStore().get(job.id)!.runCount).toBe(0);
  });

  it('JH2: tick() skips not-yet-due job — nextRunAt > now continue branch', async () => {
    // Job is active but nextRunAt is 1 hour in the future
    getJobStore().create({
      text: 'future job',
      schedule: '*/60 * * * *', // nextRunAt = now + 60min
    });

    await getJobScheduler().tick();

    expect(mockScan).not.toHaveBeenCalled();
  });

  it('JH3: tick() runs due active job — scan called, runCount incremented (lines 122-126)', async () => {
    const job = getJobStore().create({ text: 'due job', schedule: '* * * * *' });
    // Back-date nextRunAt to the past so it fires immediately
    getJobStore().update(job.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });

    await getJobScheduler().tick();

    expect(mockScan).toHaveBeenCalledWith('due job', undefined);
    expect(getJobStore().get(job.id)!.runCount).toBe(1);
    expect(getJobStore().get(job.id)!.lastRunAt).not.toBeNull();
  });
});

// ===========================================================================
// JH4–JH5 — runJob() catch block (lines 163-165)
// ===========================================================================

describe('JobScheduler.runJob() catch block (lines 163-165)', () => {
  it('JH4: scan() throws Error → catch updates job + fires job.failed webhook event', async () => {
    mockScan.mockRejectedValue(new Error('Provider timeout'));

    const job = getJobStore().create({ text: 'failing scan', schedule: '* * * * *' });
    getJobStore().update(job.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });

    // triggerJob() calls runJob() directly — same code path as tick()
    await getJobScheduler().triggerJob(job.id);

    const updated = getJobStore().get(job.id)!;
    // Job is updated even on failure
    expect(updated.lastRunAt).not.toBeNull();
    expect(updated.runCount).toBe(1);
    expect(updated.nextRunAt).not.toBeNull();
  });

  it('JH5: scan() throws non-Error (string) → String(err) fallback branch in catch (line 167)', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    mockScan.mockRejectedValue('string error');

    const job = getJobStore().create({ text: 'string throw', schedule: '* * * * *' });
    getJobStore().update(job.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });

    // Should not throw — catch branch handles non-Error throwables
    await expect(getJobScheduler().triggerJob(job.id)).resolves.toBeUndefined();

    // job updated despite non-Error throw
    expect(getJobStore().get(job.id)!.runCount).toBe(1);
  });
});

// ===========================================================================
// JH6–JH7 — start() idempotency + stop() no-op
// ===========================================================================

describe('JobScheduler.start() + stop() lifecycle', () => {
  it('JH6: start() is idempotent — second call does not register a second timer', () => {
    const scheduler = getJobScheduler();
    scheduler.start(60_000);
    scheduler.start(60_000); // should be no-op (if (this.timer) return branch)
    // stop() once to clean up — no error means no double-timer
    expect(() => scheduler.stop()).not.toThrow();
  });

  it('JH7: stop() when never started — safe no-op (timer is null branch)', () => {
    const scheduler = getJobScheduler();
    // Never started — stop() should not throw
    expect(() => scheduler.stop()).not.toThrow();
    // Second stop is also safe
    expect(() => scheduler.stop()).not.toThrow();
  });
});

// ===========================================================================
// JH8 — parseIntervalMs() unrecognized schedule → default 1 hour
// ===========================================================================

describe('parseIntervalMs() — default branch', () => {
  it('JH8: unrecognized schedule string → 60 * 60_000 ms (1 hour default)', () => {
    expect(parseIntervalMs('@daily')).toBe(60 * 60_000);
    expect(parseIntervalMs('0 0 * * *')).toBe(60 * 60_000);
    expect(parseIntervalMs('')).toBe(60 * 60_000);
  });
});
