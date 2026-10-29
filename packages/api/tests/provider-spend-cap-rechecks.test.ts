/**
 * The provider spend gate re-checks work that was admitted under the budget but
 * calls a provider later: each file of a bulk ZIP, and a full-scan job that
 * waited in the queue for a slot. Also: a server-key call forwarding
 * `x-user-tier: userkey` is capped like free, a scheduled job's stored error is
 * sanitised, and no response carries the internal gate tier.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import AdmZip from 'adm-zip';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim } from '@nxtg/faultline/types.js';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetScanStore } from '../src/store/scans.js';
import { getBulkJobStore, resetBulkJobStore } from '../src/store/bulk-jobs.js';
import { getScanQueue, resetScanQueue } from '../src/store/scan-queue.js';
import { getJobScheduler, resetJobScheduler, resetJobStore } from '../src/store/jobs.js';
import { resetScheduleRunner, resetScheduleStore } from '../src/store/schedules.js';
import { getFullScanJobStore, resetFullScanJobStore, UNSERVED_REASONS } from '../src/store/full-scan-jobs.js';
import { resetFullScanEstimateLimiter } from '../src/routes/full-scan.js';
import { recordProviderSpend, resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { PROVIDER_BUDGET_EXHAUSTED, resolveSpendCapTier } from '../src/plugins/provider-spend-cap.js';
import type { ManagedScanCostEvent } from '../src/store/costs.js';
import { scan, extractForFullScan, verifyFullScan, type FullScanResult } from '@nxtg/faultline/cli/scan.js';

vi.mock('@nxtg/faultline/cli/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/cli/scan.js')>();
  return { ...actual, scan: vi.fn(), extractForFullScan: vi.fn(), verifyFullScan: vi.fn() };
});
const scanMock = vi.mocked(scan);
const extractMock = vi.mocked(extractForFullScan);
const verifyMock = vi.mocked(verifyFullScan);

const SCAN_RESULT = {
  input: 'The sky is blue.',
  provider: 'mock',
  claims: [{ id: 'c1', text: 'The sky is blue.', type: 'fact', importance: 3 }],
  verifications: { c1: { claimId: 'c1', status: 'supported', explanation: 'Observable.', sources: [] } },
  overallRisk: 'low',
};

const SERVER_KEY = 'server-key-spend-cap-rechecks';
const ENV_KEYS = [
  'FAULTLINE_API_KEY',
  'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_PROVIDER_SPEND_CAP_USD',
  'FAULTLINE_PROVIDER_SPEND_LEDGER',
  'FAULTLINE_FULL_JOBS_LEDGER',
  'FAULTLINE_FULL_MAX_RUNNING',
];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let server: FastifyInstance;

function costEvent(costUsd: number): ManagedScanCostEvent {
  return {
    scanId: 'prior-scan', ts: new Date().toISOString(), tier: 'free', keyMode: 'managed',
    provider: 'openai', modelId: 'gpt-4o', inputTokens: 1, outputTokens: 1,
    groundingCalls: 0, costUsd, latencyMs: 1,
  };
}

/** Enforcement on with a $1 cap and nothing spent yet: the route gates admit. */
function enforceWithBudgetLeft(): void {
  process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
  process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '1';
}

/** Push this month's spend past the $1 cap. */
function spendPastCap(): void {
  recordProviderSpend(costEvent(1.5));
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-spend-rechecks-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_FULL_JOBS_LEDGER = join(tmpDir, 'full-scan-jobs.jsonl');
  resetProviderSpendLedger();
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetScanStore();
  resetBulkJobStore();
  resetScanQueue();
  resetJobStore();
  resetJobScheduler();
  resetScheduleStore();
  resetScheduleRunner();
  resetFullScanJobStore();
  resetFullScanEstimateLimiter();
  scanMock.mockReset();
  scanMock.mockResolvedValue(SCAN_RESULT as never);
  extractMock.mockReset();
  verifyMock.mockReset();
  server = buildServer();
  await server.ready();
});
afterEach(async () => {
  await server.close();
  getScanQueue().stop();
  resetFullScanJobStore();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Bulk ZIP ────────────────────────────────────────────────────────────────

const BOUNDARY = 'SpendCapRecheckBoundary';

function bulkBody(fileCount: number): Buffer {
  const zip = new AdmZip();
  for (let i = 1; i <= fileCount; i++) zip.addFile(`doc${i}.txt`, Buffer.from(`Document ${i} says the sky is blue.`));
  const crlf = '\r\n';
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}${crlf}Content-Disposition: form-data; name="archive"; filename="docs.zip"${crlf}`
        + `Content-Type: application/zip${crlf}${crlf}`,
    ),
    zip.toBuffer(),
    Buffer.from(`${crlf}--${BOUNDARY}--${crlf}`),
  ]);
}

async function runBulk(apiKey: string, fileCount: number) {
  const res = await server.inject({
    method: 'POST', url: '/scan/bulk?provider=mock',
    headers: { 'x-api-key': apiKey, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: bulkBody(fileCount),
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  await vi.waitFor(() => expect(getBulkJobStore().get(jobId)?.status).toBe('done'));
  return getBulkJobStore().get(jobId)!;
}

describe('POST /scan/bulk re-checks the budget before each file', () => {
  it('a free key: the first scan spends past the cap, so exactly 1 of 5 files is scanned', async () => {
    enforceWithBudgetLeft();
    scanMock.mockImplementation(async () => {
      spendPastCap();
      return SCAN_RESULT as never;
    });
    const free = getKeyStore().create('Free Key', ['scan']);
    const job = await runBulk(free.key, 5);

    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(job.results).toHaveLength(5);
    expect(job.processedFiles).toBe(5);
    expect(job.progressPercent).toBe(100);
    expect(job.results.filter((r) => r.status === 'done')).toHaveLength(1);
    const refused = job.results.filter((r) => r.status === 'failed');
    expect(refused).toHaveLength(4);
    for (const r of refused) expect(r.error).toBe(PROVIDER_BUDGET_EXHAUSTED);
  });

  it('a pro key: the same archive scans all 5 files', async () => {
    enforceWithBudgetLeft();
    scanMock.mockImplementation(async () => {
      spendPastCap();
      return SCAN_RESULT as never;
    });
    const pro = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const job = await runBulk(pro.key, 5);

    expect(scanMock).toHaveBeenCalledTimes(5);
    expect(job.results).toHaveLength(5);
    expect(job.results.every((r) => r.status === 'done')).toBe(true);
  });

  it('the server key with no tier header is capped per file too', async () => {
    enforceWithBudgetLeft();
    scanMock.mockImplementation(async () => {
      spendPastCap();
      return SCAN_RESULT as never;
    });
    const job = await runBulk(SERVER_KEY, 3);
    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(job.results.filter((r) => r.error === PROVIDER_BUDGET_EXHAUSTED)).toHaveLength(2);
  });
});

// ── Queued full scans ───────────────────────────────────────────────────────

const FACT_CLAIMS: Claim[] = [
  { id: 'c1', text: 'The sky is blue.', type: 'fact', importance: 3 },
  { id: 'c2', text: 'Water is wet.', type: 'fact', importance: 3 },
] as Claim[];

function fullScanResult(): FullScanResult {
  return { verification: { verifiedClaims: 0 }, notAttemptedClaimIds: [] } as unknown as FullScanResult;
}

/** A verifyFullScan call that resolves only when the test says so. */
function holdVerify(): () => void {
  let release!: () => void;
  const held = new Promise<FullScanResult>((resolve) => {
    release = () => resolve(fullScanResult());
  });
  verifyMock.mockImplementationOnce(() => held);
  return release;
}

async function startFullScan(apiKey: string, idempotencyKey: string): Promise<string> {
  const estimate = await server.inject({
    method: 'POST', url: '/scan/full/estimate',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    payload: { text: 'The sky is blue. Water is wet.', provider: 'mock' },
  });
  expect(estimate.statusCode).toBe(200);
  const start = await server.inject({
    method: 'POST', url: '/scan/full',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    payload: { estimateId: estimate.json().estimateId },
  });
  expect(start.statusCode).toBe(202);
  return start.json().jobId as string;
}

async function getFullScan(apiKey: string, jobId: string) {
  const res = await server.inject({ method: 'GET', url: `/scan/full/${jobId}`, headers: { 'x-api-key': apiKey } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('a queued full scan is re-checked when it leaves the queue', () => {
  beforeEach(() => {
    process.env.FAULTLINE_FULL_MAX_RUNNING = '1';
    extractMock.mockResolvedValue({ claims: FACT_CLAIMS, factClaims: 2, notCheckable: 0, units: 1 } as never);
  });

  it('a free job waiting behind a pro job never verifies once spend passes the cap, and is fully refunded', async () => {
    enforceWithBudgetLeft();
    const pro = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const free = getKeyStore().create('Free Key', ['scan']);
    const releasePro = holdVerify();

    const proJob = await startFullScan(pro.key, 'idem-pro-holds-slot');
    await vi.waitFor(() => expect(verifyMock).toHaveBeenCalledTimes(1));
    const freeJob = await startFullScan(free.key, 'idem-free-waits');
    expect((await getFullScan(free.key, freeJob)).status).toBe('queued');

    spendPastCap();
    releasePro();
    await vi.waitFor(async () => expect((await getFullScan(pro.key, proJob)).status).toBe('done'));
    const view = await getFullScan(free.key, freeJob);

    expect(verifyMock).toHaveBeenCalledTimes(1); // the pro job's call only
    expect(view.status).toBe('failed');
    expect(view.unserved).toHaveLength(2);
    expect(view.unserved.every((u: { reason: string }) => u.reason === PROVIDER_BUDGET_EXHAUSTED)).toBe(true);
    expect(view.units.charged).toBe(1);
    expect(view.units.refund).toBe(view.units.charged);
    expect(view).not.toHaveProperty('spendCapTier');
    expect(view).not.toHaveProperty('tier');
  });

  it('a paid job waiting behind another still runs after spend passes the cap', async () => {
    enforceWithBudgetLeft();
    const proA = getKeyStore().create('Pro Key A', ['pro', 'scan']);
    const proB = getKeyStore().create('Pro Key B', ['pro', 'scan']);
    const releaseA = holdVerify();
    verifyMock.mockResolvedValue(fullScanResult());

    const jobA = await startFullScan(proA.key, 'idem-pro-a-holds');
    await vi.waitFor(() => expect(verifyMock).toHaveBeenCalledTimes(1));
    const jobB = await startFullScan(proB.key, 'idem-pro-b-waits');
    expect((await getFullScan(proB.key, jobB)).status).toBe('queued');

    spendPastCap();
    releaseA();
    await vi.waitFor(async () => expect((await getFullScan(proB.key, jobB)).status).toBe('done'));
    expect((await getFullScan(proA.key, jobA)).status).toBe('done');
    expect(verifyMock).toHaveBeenCalledTimes(2);
  });

  it('GET /usage lists provider_budget_exhausted among the full-scan refund reasons', async () => {
    expect(UNSERVED_REASONS).toContain(PROVIDER_BUDGET_EXHAUSTED);
    const res = await server.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': SERVER_KEY } });
    expect(res.statusCode).toBe(200);
    const reasons = res.json().fullScanRefunds?.reasons as Record<string, number> | undefined;
    expect(reasons).toBeDefined();
    expect(reasons![PROVIDER_BUDGET_EXHAUSTED]).toBe(0);
    expect(getFullScanJobStore().refundSummary().reasons[PROVIDER_BUDGET_EXHAUSTED]).toBe(0);
  });
});

// ── userkey ─────────────────────────────────────────────────────────────────

describe('x-user-tier: userkey buys nothing at the spend gate', () => {
  it('the server key forwarding userkey resolves to free', () => {
    // requireApiKey names the server's own key 'admin'.
    expect(resolveSpendCapTier('admin', 'userkey')).toBe('free');
    expect(resolveSpendCapTier('admin', ['userkey'])).toBe('free');
    expect(resolveSpendCapTier('admin', 'pro')).toBe('pro');
  });

  it('POST /scan through the server key with userkey is refused with no scan once the budget is spent', async () => {
    enforceWithBudgetLeft();
    spendPastCap();
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: { 'x-api-key': SERVER_KEY, 'x-user-tier': 'userkey', 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(res.statusCode).toBe(503);
    expect(scanMock).not.toHaveBeenCalled();

    const paid = await server.inject({
      method: 'POST', url: '/scan',
      headers: { 'x-api-key': SERVER_KEY, 'x-user-tier': 'pro', 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    // A forwarded paid plan still passes the gate and reaches the scan.
    expect(paid.statusCode).not.toBe(503);
    expect(scanMock).toHaveBeenCalled();
  });
});

// ── Scheduled job errors ────────────────────────────────────────────────────

describe('GET /jobs never echoes a raw provider error', () => {
  it('a provider error with a URL and a key-like token is stored sanitised', async () => {
    const pro = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const created = await server.inject({
      method: 'POST', url: '/jobs',
      headers: { 'x-api-key': pro.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock', schedule: '*/5 * * * *' },
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id as string;

    const token = 'sk-live-abcdef0123456789abcdef';
    scanMock.mockRejectedValue(new Error(`401 Incorrect API key provided: ${token}. See https://provider.example/account/keys`));
    await getJobScheduler().triggerJob(jobId);

    const res = await server.inject({ method: 'GET', url: '/jobs', headers: { 'x-api-key': pro.key } });
    expect(res.statusCode).toBe(200);
    const jobs = res.json() as Array<{ id: string; lastError?: string }>;
    expect(jobs).toHaveLength(1);
    const lastError = jobs[0].lastError;
    expect(typeof lastError).toBe('string');
    expect(lastError!.length).toBeGreaterThan(0);
    expect(lastError).not.toContain(token);
    expect(lastError).not.toContain('https://');
    expect(res.body).not.toContain(token);
  });
});

// ── No response carries the gate tier ───────────────────────────────────────

describe('no response carries spendCapTier', () => {
  it('GET /schedules and GET /schedules/:id', async () => {
    const free = getKeyStore().create('Free Key', ['scan']);
    const created = await server.inject({
      method: 'POST', url: '/schedules',
      headers: { 'x-api-key': free.key, 'content-type': 'application/json' },
      payload: { name: 'nightly', cron: '0 9 * * 1', text: 'The sky is blue.', provider: 'mock' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).not.toHaveProperty('spendCapTier');
    const id = created.json().id as string;

    const list = await server.inject({ method: 'GET', url: '/schedules', headers: { 'x-api-key': free.key } });
    expect(list.statusCode).toBe(200);
    const schedules = list.json().schedules as unknown[];
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).not.toHaveProperty('spendCapTier');
    expect(list.body).not.toContain('spendCapTier');

    const one = await server.inject({ method: 'GET', url: `/schedules/${id}`, headers: { 'x-api-key': free.key } });
    expect(one.statusCode).toBe(200);
    expect(one.body).not.toContain('spendCapTier');
  });

  it('POST /queue/scans and GET /queue/scans/:id', async () => {
    const free = getKeyStore().create('Free Key', ['scan']);
    const queued = await server.inject({
      method: 'POST', url: '/queue/scans',
      headers: { 'x-api-key': free.key, 'content-type': 'application/json' },
      payload: { text: 'The sky is blue.', provider: 'mock' },
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.body).not.toContain('spendCapTier');
    const id = queued.json().id as string;
    expect(getScanQueue().spendCapTierOf(id)).toBe('free');

    const res = await server.inject({ method: 'GET', url: `/queue/scans/${id}`, headers: { 'x-api-key': free.key } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    expect(res.body).not.toContain('spendCapTier');
  });
});
