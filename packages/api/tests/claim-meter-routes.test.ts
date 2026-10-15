// Validates: node 1.18.11.7.6 (claim meter on the verifying routes, GET /usage, key billing fields)
//
// Every test runs the real engine through Fastify inject. The 'mock' provider
// is replaced by a fixture that splits text into one fact claim per sentence
// and answers each claim from `control.verdicts`, so a test can count provider
// calls, return chosen verdicts, fail extraction, or hold verifies in flight.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { registerProvider } from '@nxtg/faultline/providers/registry.js';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getClaimMeter, resetClaimMeter, type ClaimMeterRow } from '../src/store/claim-meter.js';
import { resetStripeMeterSink } from '../src/store/claim-meter-sync.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { getFullScanJobStore, resetFullScanJobStore } from '../src/store/full-scan-jobs.js';
import { resetFullScanEstimateLimiter } from '../src/routes/full-scan.js';
import { getJobScheduler, getJobStore, resetJobStore, resetJobScheduler } from '../src/store/jobs.js';
import { getScanQueue, resetScanQueue } from '../src/store/scan-queue.js';
import { getScheduleRunner, getScheduleStore, resetScheduleRunner, resetScheduleStore } from '../src/store/schedules.js';

type Verdict = Partial<VerificationResult>;

const control = {
  extractCalls: 0,
  verifyCalls: 0,
  extractFails: false,
  /** Verdict per claim id; default supported. */
  verdicts: {} as Record<string, Verdict>,
  /** While set, every verify waits on it. */
  gate: null as Promise<void> | null,
};

registerProvider('mock', () => ({
  name: 'Meter fixture',
  modelId: 'fixture-v1',
  extractClaims: async (text: string): Promise<Claim[]> => {
    control.extractCalls += 1;
    if (control.extractFails) throw new Error('extraction exploded');
    return text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean)
      .map((s, i) => ({ id: `c${i + 1}`, text: s, type: 'fact' as const, importance: 5 }));
  },
  verifyClaim: async (claim: Claim): Promise<VerificationResult> => {
    control.verifyCalls += 1;
    if (control.gate) await control.gate;
    return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: [], ...control.verdicts[claim.id] } as VerificationResult;
  },
  generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
}) as never);

const SERVER_KEY = 'claim-meter-server-key-0123456789';
const ENV_KEYS = [
  'FAULTLINE_API_KEY', 'FAULTLINE_DEFAULT_CLAIM_CAP', 'FAULTLINE_CLAIM_METER_LEDGER', 'FAULTLINE_CLAIM_METER_SYNC_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_FULL_JOBS_LEDGER', 'FAULTLINE_GROUNDING_LEDGER', 'STRIPE_SECRET_KEY',
  'FAULTLINE_STRIPE_METER_EVENT',
];
let saved: Record<string, string | undefined>;
let dir: string;
let app: FastifyInstance;

beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-claim-routes-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  delete process.env.FAULTLINE_DEFAULT_CLAIM_CAP;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.FAULTLINE_STRIPE_METER_EVENT;
  process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_CLAIM_METER_SYNC_LEDGER = join(dir, 'claim-meter-sync.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  process.env.FAULTLINE_FULL_JOBS_LEDGER = join(dir, 'full-scan-jobs.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding.jsonl');
  Object.assign(control, { extractCalls: 0, verifyCalls: 0, extractFails: false, verdicts: {}, gate: null });
  resetClaimMeter();
  resetStripeMeterSink();
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  resetProviderSpendLedger();
  resetCircuitBreaker();
  resetFullScanJobStore();
  resetFullScanEstimateLimiter();
  app = buildServer();
  await app.ready();
});

afterEach(async () => {
  control.gate = null;
  await app.close();
  resetFullScanJobStore();
  resetJobStore();
  resetJobScheduler();
  resetScanQueue();
  resetScheduleStore();
  resetScheduleRunner();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetClaimMeter();
  rmSync(dir, { recursive: true, force: true });
});

const sentences = (n: number): string => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} states a checkable fact.`).join(' ');

function customer(claimCap?: number, stripeCustomerId?: string) {
  return getKeyStore().create('customer', ['scan'], undefined, { claimCap, stripeCustomerId });
}

function post(url: string, key: string, payload: object, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: { 'x-api-key': key, 'content-type': 'application/json', ...headers }, payload });
}

function usage(keyId: string) {
  const meter = getClaimMeter();
  return { used: meter.usageFor(keyId).used, reserved: meter.reservedFor(keyId) };
}

function ledgerRows(): ClaimMeterRow[] {
  const path = process.env.FAULTLINE_CLAIM_METER_LEDGER as string;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ClaimMeterRow);
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('the cap is enforced before any verification', () => {
  it('402 claim_cap_reached with cap, used, remaining, and no provider call', async () => {
    const key = customer(5); // /scan reserves its verify cap (8) before extraction
    const res = await post('/scan', key.key, { text: sentences(1), provider: 'mock' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: 'claim_cap_reached', cap: 5, used: 0, remaining: 5 });
    expect(control.extractCalls).toBe(0);
    expect(control.verifyCalls).toBe(0);
    expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });
  });

  it('a key at its cap is refused after use, with the remaining it has', async () => {
    const key = customer(10);
    expect((await post('/scan', key.key, { text: sentences(3), provider: 'mock' })).statusCode).toBe(200);
    const res = await post('/scan', key.key, { text: sentences(1), provider: 'mock' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: 'claim_cap_reached', cap: 10, used: 3, remaining: 7 });
  });

  it('a customer key with no claimCap is refused unless FAULTLINE_DEFAULT_CLAIM_CAP is set', async () => {
    const key = customer();
    const refused = await post('/scan', key.key, { text: sentences(1), provider: 'mock' });
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toEqual({ error: 'claim_cap_reached', cap: 0, used: 0, remaining: 0 });
    expect(control.extractCalls).toBe(0);

    process.env.FAULTLINE_DEFAULT_CLAIM_CAP = '50';
    const allowed = await post('/scan', key.key, { text: sentences(2), provider: 'mock' });
    expect(allowed.statusCode).toBe(200);
    expect(usage(key.id).used).toBe(2);
  });

  it('a key with its own claimCap uses it over the env default', async () => {
    process.env.FAULTLINE_DEFAULT_CLAIM_CAP = '1000';
    const key = customer(4);
    expect((await post('/scan', key.key, { text: sentences(1), provider: 'mock' })).statusCode).toBe(402);
  });
});

describe('commit counts claims with a verdict; everything else is released', () => {
  it('a 3-claim text under an 8-claim reservation ends with used=3, reserved=0', async () => {
    const key = customer(100);
    const res = await post('/scan', key.key, { text: sentences(3), provider: 'mock' });
    expect(res.statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 3, reserved: 0 });
    const scanId = res.json().scanId as string;
    expect(ledgerRows().map((r) => r.identifier)).toEqual([`${scanId}:c1`, `${scanId}:c2`, `${scanId}:c3`]);
    expect(ledgerRows()[0]).toMatchObject({ keyId: key.id, scanId, verdict: 'supported', period: expect.stringMatching(/^\d{4}-\d{2}$/) });
  });

  it('unverified bills; a provider error (apiError) does not', async () => {
    control.verdicts = {
      c1: { status: 'contradicted' },
      c2: { status: 'unverified' },
      c3: { status: 'unverified', apiError: true, apiErrorReason: 'rate_limited' },
    };
    const key = customer(100);
    expect((await post('/scan', key.key, { text: sentences(4), provider: 'mock' })).statusCode).toBe(200);
    expect(getClaimMeter().usageFor(key.id)).toEqual({ used: 3, byVerdict: { contradicted: 1, unverified: 1, supported: 1 } });
    expect(usage(key.id).reserved).toBe(0);
  });

  it('an engine error commits nothing and releases the reservation', async () => {
    control.extractFails = true;
    const key = customer(100);
    const res = await post('/scan', key.key, { text: sentences(3), provider: 'mock' });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(control.extractCalls).toBeGreaterThan(0);
    expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });
    expect(ledgerRows()).toHaveLength(0);
  });

  it('a malformed provider verdict is not billed (the engine keeps it as a provider error)', async () => {
    control.verdicts = { c1: { status: 'pwned' as never } };
    const key = customer(100);
    const res = await post('/scan', key.key, { text: sentences(2), provider: 'mock' });
    expect(res.statusCode).toBe(200);
    expect(res.json().verifications.c1.apiError).toBe(true);
    expect(usage(key.id)).toEqual({ used: 1, reserved: 0 });
  });

  it('a cached verdict delivered to the caller bills again', async () => {
    const key = customer(100);
    const first = await post('/scan', key.key, { text: sentences(2), provider: 'mock' });
    const second = await post('/scan', key.key, { text: sentences(2), provider: 'mock' });
    expect(second.headers['x-cache']).toBe('HIT');
    expect(control.verifyCalls).toBe(2);
    expect(usage(key.id)).toEqual({ used: 4, reserved: 0 });
    expect(first.json().scanId).not.toBe(second.json().scanId);
  });
});

describe('who is metered', () => {
  it('the server key and admin keys are not metered', async () => {
    const admin = getKeyStore().create('ops', ['admin']);
    expect((await post('/scan', SERVER_KEY, { text: sentences(2), provider: 'mock' })).statusCode).toBe(200);
    expect((await post('/scan', admin.key, { text: sentences(2), provider: 'mock' })).statusCode).toBe(200);
    expect(control.verifyCalls).toBe(4);
    expect(ledgerRows()).toHaveLength(0);
    expect(getClaimMeter().totals().reserved).toBe(0);
  });
});

describe('concurrency', () => {
  it('two concurrent requests whose headroom fits one reservation: exactly one proceeds', async () => {
    const key = customer(8); // one /scan reservation (8) fits, two do not
    let open!: () => void;
    control.gate = new Promise<void>((resolve) => { open = resolve; });
    const [a, b] = [post('/scan', key.key, { text: sentences(1), provider: 'mock' }), post('/scan', key.key, { text: sentences(1), provider: 'mock' })];
    await until(() => control.verifyCalls >= 1, 'the first verify to start');
    open();
    const codes = (await Promise.all([a, b])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 402]);
    expect(control.verifyCalls).toBe(1);
    expect(usage(key.id)).toEqual({ used: 1, reserved: 0 });
  });

  it('the reservation is held while the first request is still verifying', async () => {
    const key = customer(12);
    let open!: () => void;
    control.gate = new Promise<void>((resolve) => { open = resolve; });
    const first = post('/scan', key.key, { text: sentences(1), provider: 'mock' });
    await until(() => control.verifyCalls === 1, 'the first verify');
    expect(usage(key.id).reserved).toBe(8);
    const second = await post('/scan', key.key, { text: sentences(1), provider: 'mock' });
    expect(second.statusCode).toBe(402);
    expect(second.json()).toEqual({ error: 'claim_cap_reached', cap: 12, used: 0, remaining: 4 });
    open();
    expect((await first).statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 1, reserved: 0 });
  });
});

describe('streaming routes', () => {
  it('GET and POST /scan/stream commit each delivered verdict and end with nothing reserved', async () => {
    const key = customer(100);
    const get = await app.inject({ method: 'GET', url: `/scan/stream?provider=mock&text=${encodeURIComponent(sentences(2))}`, headers: { 'x-api-key': key.key } });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('"type":"complete"');
    expect(usage(key.id)).toEqual({ used: 2, reserved: 0 });

    const res = await post('/scan/stream', key.key, { text: sentences(3), provider: 'mock' });
    expect(res.statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 5, reserved: 0 });
    expect(new Set(ledgerRows().map((r) => r.scanId)).size).toBe(2);
  });

  it('a stream over the cap is refused before it opens', async () => {
    const key = customer(3);
    const res = await post('/scan/stream', key.key, { text: sentences(1), provider: 'mock' });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('claim_cap_reached');
    expect(control.extractCalls).toBe(0);
  });

  it('a stream whose engine fails ends with nothing reserved and nothing billed', async () => {
    control.extractFails = true;
    const key = customer(100);
    const res = await post('/scan/stream', key.key, { text: sentences(2), provider: 'mock' });
    expect(res.body).toContain('"type":"error"');
    expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });
  });
});

describe('other verifying routes reserve their own maximum', () => {
  it('/scan/batch reserves 8 per text and bills each text', async () => {
    const tight = customer(15);
    const refused = await post('/scan/batch', tight.key, { texts: [sentences(1), sentences(1)], provider: 'mock' });
    expect(refused.statusCode).toBe(402);
    expect(control.extractCalls).toBe(0);

    const key = customer(16);
    const res = await post('/scan/batch', key.key, { texts: [sentences(1), sentences(2)], provider: 'mock' });
    expect(res.statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 3, reserved: 0 });
  });

  it('/scan/diff reserves two scans and bills both', async () => {
    const key = customer(16);
    const res = await post('/scan/diff', key.key, { before: sentences(1), after: sentences(2), provider: 'mock' });
    expect(res.statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 3, reserved: 0 });
    expect((await post('/scan/diff', customer(15).key, { before: 'a.', after: 'b.', provider: 'mock' })).statusCode).toBe(402);
  });

  it('/scan/template/:id meters the template scan', async () => {
    const key = customer(100);
    const tpl = await post('/templates', key.key, { name: 'tpl', provider: 'mock' });
    expect(tpl.statusCode).toBe(201);
    const res = await post(`/scan/template/${tpl.json().id}`, key.key, { text: sentences(2), provider: 'mock' });
    expect(res.statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 2, reserved: 0 });
  });
});

describe('full scan: the estimate reserves nothing, the job reserves its fact claims', () => {
  async function estimate(key: string, n: number) {
    const res = await post('/scan/full/estimate', key, { text: sentences(n), provider: 'mock' });
    expect(res.statusCode).toBe(200);
    return res.json() as { estimateId: string; factClaims: number };
  }

  it('commits served claims when the job finishes and holds them while it runs', async () => {
    const key = customer(5);
    const est = await estimate(key.key, 3);
    expect(est.factClaims).toBe(3);
    expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });

    let open!: () => void;
    control.gate = new Promise<void>((resolve) => { open = resolve; });
    const start = await post('/scan/full', key.key, { estimateId: est.estimateId }, { 'idempotency-key': 'idem-meter-0001' });
    expect(start.statusCode).toBe(202);
    await until(() => control.verifyCalls >= 1, 'the job to start verifying');
    expect(usage(key.id).reserved).toBe(3);
    open();
    const jobId = start.json().jobId as string;
    await until(() => getFullScanJobStore().lookup(jobId, key.id).kind !== 'job'
      || (getFullScanJobStore().lookup(jobId, key.id) as { job: { status: string } }).job.status === 'done', 'the job to finish');
    expect(usage(key.id)).toEqual({ used: 3, reserved: 0 });
    expect(ledgerRows().every((r) => r.scanId === jobId)).toBe(true);
  });

  it('a job over the cap is refused with 402 and verifies nothing', async () => {
    const key = customer(2);
    const est = await estimate(key.key, 3);
    const start = await post('/scan/full', key.key, { estimateId: est.estimateId }, { 'idempotency-key': 'idem-meter-0002' });
    expect(start.statusCode).toBe(402);
    expect(start.json()).toEqual({ error: 'claim_cap_reached', cap: 2, used: 0, remaining: 2 });
    await settle();
    expect(control.verifyCalls).toBe(0);
  });

  it('a stopped job bills only the claims served before the stop', async () => {
    const key = customer(10);
    const est = await estimate(key.key, 6);
    let open!: () => void;
    control.gate = new Promise<void>((resolve) => { open = resolve; });
    const start = await post('/scan/full', key.key, { estimateId: est.estimateId }, { 'idempotency-key': 'idem-meter-0003' });
    const jobId = start.json().jobId as string;
    await until(() => control.verifyCalls >= 4, 'claims in flight');
    const stopped = await post(`/scan/full/${jobId}/stop`, key.key, {});
    expect(stopped.statusCode).toBe(200);
    open();
    await until(() => usage(key.id).reserved === 0, 'the reservation to settle');
    expect(usage(key.id).used).toBe(4); // FULL_SCAN_CONCURRENCY claims were in flight; the rest never started
  });
});

describe('background runners reserve when they run', () => {
  it('a queued scan over the cap fails unscanned; under the cap it bills', async () => {
    const tight = customer(8);
    const enq = await post('/queue/scans', tight.key, { text: sentences(2), provider: 'mock' });
    expect(enq.statusCode).toBeLessThan(300);
    // Use the headroom up after enqueue, so the run itself must refuse.
    getClaimMeter().append(tight.id, getClaimMeter().totals().period, 'pre', [{ claimId: 'x', verdict: 'supported', provider: 'mock' }]);
    getScanQueue().tick();
    await until(() => getScanQueue().list(tight.id).every((i) => i.status === 'failed' || i.status === 'completed'), 'the queue item');
    expect(getScanQueue().list(tight.id)[0]).toMatchObject({ status: 'failed', error: 'claim_cap_reached' });
    expect(control.extractCalls).toBe(0);

    const roomy = customer(100);
    await post('/queue/scans', roomy.key, { text: sentences(2), provider: 'mock' });
    getScanQueue().tick();
    await until(() => usage(roomy.id).used === 2, 'the queued scan to bill');
    expect(usage(roomy.id).reserved).toBe(0);
  });

  it('a submit route answers 402 when the key cannot cover one run', async () => {
    const key = customer(7);
    const routes: Array<[string, object]> = [
      ['/queue/scans', { text: sentences(1), provider: 'mock' }],
      ['/jobs', { text: sentences(1), provider: 'mock', schedule: 'hourly' }],
      ['/schedules', { text: sentences(1), provider: 'mock', cron: '0 0 * * 0', name: 'n' }],
    ];
    for (const [url, body] of routes) {
      const res = await post(url, key.key, body);
      expect(res.statusCode, url).toBe(402);
      expect(res.json(), url).toEqual({ error: 'claim_cap_reached', cap: 7, used: 0, remaining: 7 });
    }
    expect(usage(key.id).reserved).toBe(0);
  });

  it('a scheduled job run is metered against its creator', async () => {
    const key = customer(100);
    const created = await post('/jobs', key.key, { text: sentences(2), provider: 'mock', schedule: 'hourly' });
    expect(created.statusCode).toBe(201);
    await getJobScheduler().triggerJob(created.json().id);
    expect(usage(key.id)).toEqual({ used: 2, reserved: 0 });
    expect(getJobStore().get(created.json().id)?.runCount).toBe(1);
  });

  it('a schedule run is metered; over the cap it records claim_cap_reached and calls no provider', async () => {
    const key = customer(9);
    const created = await post('/schedules', key.key, { text: sentences(2), provider: 'mock', cron: '0 0 * * 0', name: 'weekly' });
    expect(created.statusCode).toBe(201);
    const schedule = getScheduleStore().get(created.json().id)!;
    await getScheduleRunner().runSchedule(schedule);
    expect(usage(key.id)).toEqual({ used: 2, reserved: 0 });
    const calls = control.extractCalls;
    await getScheduleRunner().runSchedule(schedule); // 2 used + 8 > 9
    expect(control.extractCalls).toBe(calls);
    expect(getScheduleStore().get(schedule.id)?.lastResult?.error).toBe('claim_cap_reached');
  });
});

describe('GET /usage', () => {
  it('a customer key sees its own claims block', async () => {
    const key = customer(20);
    control.verdicts = { c2: { status: 'unverified' } };
    await post('/scan', key.key, { text: sentences(2), provider: 'mock' });
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': key.key } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claims).toEqual({
      period: expect.stringMatching(/^\d{4}-\d{2}$/),
      cap: 20,
      used: 2,
      reserved: 0,
      remaining: 18,
      byVerdict: { supported: 1, contradicted: 0, mixed: 0, unverified: 1 },
    });
    expect(body.claimMeter).toBeUndefined();
  });

  it('admin sees fleet meter totals and sync lag, and no per-key claims block', async () => {
    const a = customer(50);
    const b = customer(50);
    await post('/scan', a.key, { text: sentences(2), provider: 'mock' });
    await post('/scan', b.key, { text: sentences(1), provider: 'mock' });
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': SERVER_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claims).toBeUndefined();
    expect(body.claimMeter).toMatchObject({
      used: 3,
      reserved: 0,
      keys: 2,
      byVerdict: { supported: 3, contradicted: 0, mixed: 0, unverified: 0 },
      ledgerWriteFailures: 0,
      sync: { enabled: false, eventName: null, meterSyncLagRows: 3, oldestUnsentAt: expect.any(String), oldestUnsentAgeSeconds: expect.any(Number) },
    });
  });
});

describe('key billing fields', () => {
  it('POST /keys sets claimCap and stripeCustomerId; PATCH changes and clears them', async () => {
    const created = await post('/keys', SERVER_KEY, { name: 'cust', permissions: ['scan'], claimCap: 500, stripeCustomerId: 'cus_Test123' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ claimCap: 500, stripeCustomerId: 'cus_Test123' });
    const id = created.json().id as string;

    const patched = await app.inject({ method: 'PATCH', url: `/keys/${id}`, headers: { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' }, payload: { claimCap: 10 } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ claimCap: 10, stripeCustomerId: 'cus_Test123' });

    const cleared = await app.inject({ method: 'PATCH', url: `/keys/${id}`, headers: { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' }, payload: { claimCap: null, stripeCustomerId: null } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().claimCap).toBeUndefined();
    expect(cleared.json().stripeCustomerId).toBeUndefined();
  });

  it('rejects a negative cap and a malformed customer id', async () => {
    for (const body of [{ claimCap: -1 }, { claimCap: 1.5 }, { stripeCustomerId: 'not-a-customer' }, { stripeCustomerId: 'cus_bad id' }]) {
      const res = await post('/keys', SERVER_KEY, { name: 'x', permissions: ['scan'], ...body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('a customer key cannot set its own cap', async () => {
    const key = customer(1);
    const res = await app.inject({ method: 'PATCH', url: `/keys/${key.id}`, headers: { 'x-api-key': key.key, 'content-type': 'application/json' }, payload: { claimCap: 1_000_000 } });
    expect(res.statusCode).toBe(403);
    expect(getKeyStore().validateById(key.id)?.claimCap).toBe(1);
  });
});
