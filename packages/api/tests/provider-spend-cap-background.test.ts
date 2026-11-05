/**
 * The provider spend gate for work that runs with no request: the scan queue
 * worker, scheduled jobs, schedules, and the GraphQL scan resolvers.
 *
 * The queue, job and schedule entries store the gate tier when they are created
 * (from `resolveSpendCapTier`). When one runs with enforcement on and the month's
 * budget spent, a capped tier is skipped and marked failed with the reason
 * `provider_budget_exhausted`, and no scan runs. An entry with no stored tier
 * (created before tiers were stored) counts as capped. A paid tier still runs,
 * and nothing is refused while enforcement is off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetScanStore } from '../src/store/scans.js';
import { getScanQueue, resetScanQueue, type ScanQueueItem } from '../src/store/scan-queue.js';
import { getJobScheduler, getJobStore, resetJobScheduler, resetJobStore } from '../src/store/jobs.js';
import { getScheduleRunner, getScheduleStore, resetScheduleRunner, resetScheduleStore } from '../src/store/schedules.js';
import { recordProviderSpend, resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { PROVIDER_BUDGET_EXHAUSTED, providerBudgetRefuses } from '../src/plugins/provider-spend-cap.js';
import type { ManagedScanCostEvent } from '../src/store/costs.js';
import { scan } from '@nxtg/faultline/cli/scan.js';

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: vi.fn(),
}));
const scanMock = vi.mocked(scan);
const SCAN_RESULT = {
  input: 'The sky is blue.',
  provider: 'mock',
  claims: [{ id: 'c1', text: 'The sky is blue.', type: 'fact', importance: 3 }],
  verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'Observable.', sources: [] } },
  overallRisk: 'low',
};

const SERVER_KEY = 'server-key-spend-cap-background';
const ENV_KEYS = [
  'FAULTLINE_API_KEY',
  'FAULTLINE_GRAPHQL',
  'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_PROVIDER_SPEND_CAP_USD',
  'FAULTLINE_PROVIDER_SPEND_LEDGER',
];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

function costEvent(costUsd: number): ManagedScanCostEvent {
  return {
    scanId: 'prior-scan', ts: new Date().toISOString(), tier: 'free', keyMode: 'managed',
    provider: 'openai', modelId: 'gpt-4o', inputTokens: 1, outputTokens: 1,
    groundingCalls: 0, costUsd, latencyMs: 1,
  };
}

/** Enforcement on, cap $1, $1.50 spent. */
function exhaustBudget(): void {
  process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
  process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '1';
  recordProviderSpend(costEvent(1.5), 'customer');
}

/** Run one queue tick and wait for the item to reach a final state. */
async function drainQueue(item: ScanQueueItem): Promise<void> {
  getScanQueue().tick();
  await vi.waitFor(() => {
    expect(['completed', 'failed']).toContain(getScanQueue().get(item.id)?.status);
  });
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-spend-background-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  resetProviderSpendLedger();
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetScanStore();
  resetScanQueue();
  resetJobStore();
  resetJobScheduler();
  resetScheduleStore();
  resetScheduleRunner();
  scanMock.mockReset();
  scanMock.mockResolvedValue(SCAN_RESULT as never);
});
afterEach(() => {
  getScanQueue().stop();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('providerBudgetRefuses', () => {
  it('refuses capped and unknown tiers only while enforcement is on and the budget is spent', () => {
    // Dormant: nothing is refused, even with the budget spent.
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '1';
    recordProviderSpend(costEvent(1.5), 'customer');
    expect(providerBudgetRefuses('free')).toBe(false);
    expect(providerBudgetRefuses(undefined)).toBe(false);

    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    expect(providerBudgetRefuses('free')).toBe(true);
    expect(providerBudgetRefuses('anon')).toBe(true);
    expect(providerBudgetRefuses(undefined)).toBe(true); // no stored tier counts as capped
    expect(providerBudgetRefuses('pro')).toBe(false);
    expect(providerBudgetRefuses('enterprise')).toBe(false);

    // Budget left: nothing is refused.
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '100';
    expect(providerBudgetRefuses('free')).toBe(false);
    expect(providerBudgetRefuses(undefined)).toBe(false);
  });
});

describe('scan queue worker', () => {
  it('a free item queued through POST /queue/scans stores its tier', async () => {
    const server = buildServer();
    try {
      const free = getKeyStore().create('Free Key', ['scan']);
      const res = await server.inject({
        method: 'POST', url: '/queue/scans',
        headers: { 'x-api-key': free.key, 'content-type': 'application/json' },
        payload: { text: 'The sky is blue.', provider: 'mock' },
      });
      expect(res.statusCode).toBe(202);
      const item = getScanQueue().get(res.json().id);
      expect(item).toBeDefined();
      expect(getScanQueue().spendCapTierOf(item!.id)).toBe('free');
      expect(item).not.toHaveProperty('spendCapTier');
    } finally {
      await server.close();
    }
  });

  it('a free item is failed with provider_budget_exhausted and never scanned', async () => {
    const item = getScanQueue().enqueue('key-1', 2, 'The sky is blue.', 'mock', 'free');
    exhaustBudget();
    await drainQueue(item);
    const done = getScanQueue().get(item.id)!;
    expect(done.status).toBe('failed');
    expect(done.error).toBe(PROVIDER_BUDGET_EXHAUSTED);
    expect(done.result).toBeUndefined();
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('an item queued before tiers were stored counts as capped', async () => {
    const item = getScanQueue().enqueue('key-1', 2, 'The sky is blue.', 'mock');
    expect(getScanQueue().spendCapTierOf(item.id)).toBeUndefined();
    exhaustBudget();
    await drainQueue(item);
    expect(getScanQueue().get(item.id)!.status).toBe('failed');
    expect(getScanQueue().get(item.id)!.error).toBe(PROVIDER_BUDGET_EXHAUSTED);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('a pro item still runs', async () => {
    const item = getScanQueue().enqueue('key-1', 1, 'The sky is blue.', 'mock', 'pro');
    exhaustBudget();
    await drainQueue(item);
    expect(getScanQueue().get(item.id)!.status).toBe('completed');
    expect(scanMock).toHaveBeenCalledTimes(1);
  });

  it('with enforcement off a free item runs', async () => {
    const item = getScanQueue().enqueue('key-1', 2, 'The sky is blue.', 'mock', 'free');
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '1';
    recordProviderSpend(costEvent(1.5), 'customer');
    await drainQueue(item);
    expect(getScanQueue().get(item.id)!.status).toBe('completed');
    expect(scanMock).toHaveBeenCalledTimes(1);
  });
});

describe('scheduled jobs', () => {
  it('POST /jobs stores the tier, and a free job run is skipped as failed with no scan', async () => {
    const server = buildServer();
    try {
      const free = getKeyStore().create('Free Key', ['scan']);
      const res = await server.inject({
        method: 'POST', url: '/jobs',
        headers: { 'x-api-key': free.key, 'content-type': 'application/json' },
        payload: { text: 'The sky is blue.', provider: 'mock', schedule: '*/5 * * * *' },
      });
      expect(res.statusCode).toBe(201);
      const jobId = res.json().id as string;
      expect(getJobStore().spendCapTierOf(jobId)).toBe('free');

      exhaustBudget();
      await getJobScheduler().triggerJob(jobId);
      const job = getJobStore().get(jobId)!;
      expect(job.lastError).toBe(PROVIDER_BUDGET_EXHAUSTED);
      expect(job.lastRunAt).not.toBeNull();
      expect(job.runCount).toBe(0);
      expect(scanMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('a job created before tiers were stored counts as capped', async () => {
    const job = getJobStore().create({ text: 'The sky is blue.', provider: 'mock', schedule: '*/5 * * * *' });
    expect(getJobStore().spendCapTierOf(job.id)).toBeUndefined();
    exhaustBudget();
    await getJobScheduler().triggerJob(job.id);
    expect(getJobStore().get(job.id)!.lastError).toBe(PROVIDER_BUDGET_EXHAUSTED);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('a pro job still runs', async () => {
    const job = getJobStore().create({ text: 'The sky is blue.', provider: 'mock', schedule: '*/5 * * * *', spendCapTier: 'pro' });
    exhaustBudget();
    await getJobScheduler().triggerJob(job.id);
    expect(scanMock).toHaveBeenCalledTimes(1);
    const after = getJobStore().get(job.id)!;
    expect(after.runCount).toBe(1);
    expect(after.lastError).toBeUndefined();
  });
});

describe('schedules', () => {
  it('POST /schedules stores the tier, and a free run is recorded as failed with no scan', async () => {
    const server = buildServer();
    try {
      const free = getKeyStore().create('Free Key', ['scan']);
      const res = await server.inject({
        method: 'POST', url: '/schedules',
        headers: { 'x-api-key': free.key, 'content-type': 'application/json' },
        payload: { name: 'nightly', cron: '0 9 * * 1', text: 'The sky is blue.', provider: 'mock' },
      });
      expect(res.statusCode).toBe(201);
      const schedule = getScheduleStore().get(res.json().id)!;
      expect(getScheduleStore().spendCapTierOf(schedule.id)).toBe('free');
      expect(schedule).not.toHaveProperty('spendCapTier');

      exhaustBudget();
      await getScheduleRunner().runSchedule(schedule);
      const after = getScheduleStore().get(schedule.id)!;
      expect(after.history).toHaveLength(1);
      expect(after.lastResult?.error).toBe(PROVIDER_BUDGET_EXHAUSTED);
      expect(after.runCount).toBe(0); // a skipped run does not count toward maxRuns
      expect(scanMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('a schedule created before tiers were stored counts as capped', async () => {
    const schedule = getScheduleStore().create({ name: 'old', cron: '0 9 * * 1', text: 'The sky is blue.', provider: 'mock' }, 'key-1');
    expect(getScheduleStore().spendCapTierOf(schedule.id)).toBeUndefined();
    exhaustBudget();
    await getScheduleRunner().runSchedule(schedule);
    expect(getScheduleStore().get(schedule.id)!.lastResult?.error).toBe(PROVIDER_BUDGET_EXHAUSTED);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('a pro schedule still runs', async () => {
    const schedule = getScheduleStore().create(
      { name: 'paid', cron: '0 9 * * 1', text: 'The sky is blue.', provider: 'mock' }, 'key-1', 'pro',
    );
    exhaustBudget();
    await getScheduleRunner().runSchedule(schedule);
    const after = getScheduleStore().get(schedule.id)!;
    expect(after.lastResult?.error).toBeUndefined();
    expect(after.runCount).toBe(1);
    expect(scanMock).toHaveBeenCalledTimes(1);
  });
});

describe('GraphQL scan and scanBatch', () => {
  let server: FastifyInstance;
  beforeEach(() => {
    process.env.FAULTLINE_GRAPHQL = 'on';
    server = buildServer();
  });
  afterEach(async () => {
    await server.close();
  });

  function gql(query: string, headers: Record<string, string> = {}) {
    return server.inject({
      method: 'POST', url: '/graphql',
      headers: { 'content-type': 'application/json', 'x-api-key': SERVER_KEY, ...headers },
      payload: JSON.stringify({ query }),
    });
  }

  for (const [name, query] of [
    ['scan', '{ scan(text: "The sky is blue.") { id } }'],
    ['scanBatch', 'mutation { scanBatch(texts: ["The sky is blue."]) { id } }'],
  ] as const) {
    it(`${name}: the server key with no tier header is refused with no scan`, async () => {
      exhaustBudget();
      const res = await gql(query);
      const body = res.json() as { data?: unknown; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };
      expect(body.errors?.length ?? 0).toBeGreaterThan(0);
      expect(body.errors![0].message).toMatch(/provider budget exhausted/i);
      expect(body.errors![0].extensions?.reason).toBe(PROVIDER_BUDGET_EXHAUSTED);
      expect(scanMock).not.toHaveBeenCalled();
    });

    it(`${name}: the server key forwarding a paid tier still scans`, async () => {
      exhaustBudget();
      const res = await gql(query, { 'x-user-tier': 'pro' });
      const body = res.json() as { errors?: unknown[] };
      expect(body.errors).toBeUndefined();
      expect(scanMock).toHaveBeenCalledTimes(1);
    });
  }
});
