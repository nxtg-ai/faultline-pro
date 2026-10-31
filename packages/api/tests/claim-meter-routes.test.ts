// Validates: claim meter and usage-record contract
//
// Every test runs the real engine through Fastify inject. Every provider the
// engine resolves is a fixture answering as the engine's own 'gemini' instance
// (helpers/engine-stand-in.ts), so its sourced verdicts are billable. The fixture splits text into one fact
// claim per sentence and answers each claim from `control.verdicts`, so a test can count provider
// calls, return chosen verdicts, fail extraction, or hold verifies in flight.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { ENGINE_PROVIDER, ONE_SOURCE, placeholderProviderKey } from './helpers/engine-stand-in.js';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore, type KeyScope } from '../src/store/keys.js';
import { getClaimMeter, resetClaimMeter, type UsageRecord } from '../src/store/claim-meter.js';
import { jobRecordScanId } from '../src/lib/claim-meter.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { getScanCache, resetCache } from '../src/store/cache.js';
import { cacheCaller } from '../src/lib/cache-caller.js';
import { resolveVerifyPolicy } from '../src/plugins/verify-cap.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { describeJob, getFullScanJobStore, resetFullScanJobStore, setFullScanLedgerAppendForTests } from '../src/store/full-scan-jobs.js';
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

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const { engineStandInRegistry } = await import('./helpers/engine-stand-in.js');
  return engineStandInRegistry(await importOriginal(), () => ({
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
      return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: ONE_SOURCE, ...control.verdicts[claim.id] } as VerificationResult;
    },
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }));
});

const SERVER_KEY = 'claim-meter-server-key-0123456789';
const ENV_KEYS = [
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'FAULTLINE_API_KEY', 'FAULTLINE_CLAIM_METER', 'FAULTLINE_CLAIM_METER_LEDGER', 'FAULTLINE_KEY_IDEMPOTENCY_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_FULL_JOBS_LEDGER', 'FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_FULL_MAX_RUNNING',
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
  process.env.FAULTLINE_CLAIM_METER = '1';
  process.env.GEMINI_API_KEY = placeholderProviderKey();
  process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER = join(dir, 'key-idempotency.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  process.env.FAULTLINE_FULL_JOBS_LEDGER = join(dir, 'full-scan-jobs.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding.jsonl');
  Object.assign(control, { extractCalls: 0, verifyCalls: 0, extractFails: false, verdicts: {}, gate: null });
  resetClaimMeter();
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
  setFullScanLedgerAppendForTests(null);
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
  resetKeyStore();
  rmSync(dir, { recursive: true, force: true });
});

const sentences = (n: number): string => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} states a checkable fact.`).join(' ');

/** A metered customer key. */
function customer(claimCap?: number, stripeCustomerId?: string) {
  return getKeyStore().create('customer', ['scan'], undefined, { claimCap, stripeCustomerId, metered: true });
}

/** A customer key as every key is today: not metered. */
function unmetered() {
  return getKeyStore().create('plain', ['scan'], undefined, { claimCap: 0 });
}

function post(url: string, key: string, payload: object, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: { 'x-api-key': key, 'content-type': 'application/json', ...headers }, payload });
}

function get(url: string, key: string) {
  return app.inject({ method: 'GET', url, headers: { 'x-api-key': key } });
}

function usage(keyId: string) {
  const meter = getClaimMeter();
  return { used: meter.usageFor(keyId).used, reserved: meter.reservedFor(keyId) };
}

const ledgerPath = () => process.env.FAULTLINE_CLAIM_METER_LEDGER as string;

function ledgerRows(): UsageRecord[] {
  if (!existsSync(ledgerPath())) return [];
  return readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.kind !== 'header') as unknown as UsageRecord[];
}

/** The 402 body for a cap with nothing used, this month. */
function capReached(cap: number, used: number, remaining: number) {
  return {
    error: 'claim_cap_reached', cap, used, remaining,
    period: expect.stringMatching(/^\d{4}-\d{2}$/),
    resetsAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/),
  };
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
  it('402 claim_cap_reached with the exact body, and zero provider calls', async () => {
    const key = customer(5); // /scan reserves its verify cap (8) before extraction
    const res = await post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body).toEqual(capReached(5, 0, 5));
    expect(Object.keys(body).sort()).toEqual(['cap', 'error', 'period', 'remaining', 'resetsAt', 'used']);
    expect(control.extractCalls).toBe(0);
    expect(control.verifyCalls).toBe(0);
    expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });
  });

  it('a request larger than remaining is refused whole: nothing is part-served', async () => {
    const key = customer(10);
    expect((await post('/scan', key.key, { text: sentences(3), provider: ENGINE_PROVIDER })).statusCode).toBe(200);
    const calls = control.verifyCalls;
    expect(calls).toBe(3);
    // 7 remain, the request may verify 8: refused, though its text has one claim.
    const res = await post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual(capReached(10, 3, 7));
    expect(control.verifyCalls).toBe(calls);
    expect(usage(key.id)).toEqual({ used: 3, reserved: 0 });
  });

  it('a metered key with no claimCap gets 402 claim_cap_unset and calls no provider', async () => {
    const key = customer();
    const refused = await post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER });
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toEqual({ error: 'claim_cap_unset' });
    expect(control.extractCalls).toBe(0);
    expect(control.verifyCalls).toBe(0);
  });

  it('a metered key without stripeCustomerId runs; its rows carry null', async () => {
    const key = customer(100);
    expect((await post('/scan', key.key, { text: sentences(2), provider: ENGINE_PROVIDER })).statusCode).toBe(200);
    const rows = ledgerRows();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.stripeCustomerId === null)).toBe(true);
  });

  it('a revoked metered key stops reserving at once; its committed rows stay', async () => {
    const key = customer(100);
    expect((await post('/scan', key.key, { text: sentences(2), provider: ENGINE_PROVIDER })).statusCode).toBe(200);
    getKeyStore().disable(key.id);
    expect((await post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER })).statusCode).toBe(401);
    expect(ledgerRows().length).toBe(2);
    expect(usage(key.id).used).toBe(2);
  });
});

describe('commit counts claims with a verdict; everything else is released', () => {
  it('a 3-claim text under an 8-claim reservation ends with used=3, reserved=0', async () => {
    const key = customer(100);
    const res = await post('/scan', key.key, { text: sentences(3), provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 3, reserved: 0 });
    const issued = res.json().scanId as string;
    expect(issued.startsWith('scan-')).toBe(true);
    const scanId = issued.slice(5); // the record carries the bare UUID
    const rows = ledgerRows();
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.identifier)).toEqual([`${scanId}:c1`, `${scanId}:c2`, `${scanId}:c3`]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ kind: 'usage', keyId: key.id, scanId, verdict: 'supported', provider: ENGINE_PROVIDER, period: expect.stringMatching(/^\d{4}-\d{2}$/) });
    // No claim text, evidence or key material in the record.
    const raw = readFileSync(ledgerPath(), 'utf8');
    expect(raw).not.toContain('checkable fact');
    expect(raw).not.toContain(key.key);
  });

  it('only engine-sourced verdicts bill: not unverified, not unsourced, not a provider error', async () => {
    control.verdicts = {
      c1: { status: 'contradicted' },
      c2: { status: 'unverified' },
      c3: { status: 'unverified', apiError: true, apiErrorReason: 'rate_limited' },
      c5: { status: 'supported', sources: [] },
    };
    const key = customer(100);
    expect((await post('/scan', key.key, { text: sentences(5), provider: ENGINE_PROVIDER })).statusCode).toBe(200);
    expect(getClaimMeter().usageFor(key.id)).toEqual({ used: 2, byVerdict: { contradicted: 1, supported: 1 } });
    const rows = ledgerRows();
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.claimId)).toEqual(['c1', 'c4']);
    expect(usage(key.id).reserved).toBe(0);
  });

  it('an engine error commits nothing and releases the reservation', async () => {
    control.extractFails = true;
    const key = customer(100);
    const res = await post('/scan', key.key, { text: sentences(3), provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(control.extractCalls).toBeGreaterThan(0);
    expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });
    expect(ledgerRows()).toHaveLength(0);
  });

  it('a malformed provider verdict is not billed (the engine keeps it as a provider error)', async () => {
    control.verdicts = { c1: { status: 'pwned' as never } };
    const key = customer(100);
    const res = await post('/scan', key.key, { text: sentences(2), provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(200);
    expect(res.json().verifications.c1.apiError).toBe(true);
    expect(usage(key.id)).toEqual({ used: 1, reserved: 0 });
  });

  it('a cached verdict bills on every delivery when it keeps the engine retriever, and never without one', async () => {
    process.env.OPENAI_API_KEY = placeholderProviderKey();
    const key = customer(100);
    const text = sentences(2);
    // Under 'openai' the fixture gets no engine retriever: served and cached (the
    // cache refuses grounded Gemini results), but not billable, miss or hit.
    const miss = await post('/scan', key.key, { text, provider: 'openai' });
    expect(miss.headers['x-cache']).toBe('MISS');
    const hit = await post('/scan', key.key, { text, provider: 'openai' });
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(control.verifyCalls).toBe(2);
    expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });

    // A stored verdict that keeps an engine retriever (a consensus scan's) bills on each hit.
    const { scanId: _issued, cache: _cache, ...stored } = miss.json() as { verifications: Record<string, Record<string, unknown>> } & Record<string, unknown>;
    expect(Object.keys(stored.verifications).length).toBe(2);
    const verifications = Object.fromEntries(Object.entries(stored.verifications).map(([id, v]) =>
      [id, { ...v, provenance: { provider: 'consensus', model: 'm', verifiedAt: '2026-10-01T00:00:00.000Z', retriever: 'openai-web-search' } }]));
    const caller = cacheCaller({ keyId: key.id, headers: {} } as never) as string;
    const cap = resolveVerifyPolicy(key.id, undefined).cap;
    expect(getScanCache().set(caller, text, 'openai', { ...stored, verifications } as never, cap)).toBe(true);
    const first = await post('/scan', key.key, { text, provider: 'openai' });
    const second = await post('/scan', key.key, { text, provider: 'openai' });
    expect([first.headers['x-cache'], second.headers['x-cache']]).toEqual(['HIT', 'HIT']);
    expect(control.verifyCalls).toBe(2);
    expect(usage(key.id)).toEqual({ used: 4, reserved: 0 });
    expect(first.json().scanId).not.toBe(second.json().scanId);
  });
});

describe('who is metered', () => {
  it('the server key and admin keys are not metered, even marked metered', async () => {
    const admin = getKeyStore().create('ops', ['admin'], undefined, { metered: true, claimCap: 0 });
    expect((await post('/scan', SERVER_KEY, { text: sentences(2), provider: ENGINE_PROVIDER })).statusCode).toBe(200);
    expect((await post('/scan', admin.key, { text: sentences(2), provider: ENGINE_PROVIDER })).statusCode).toBe(200);
    expect(control.verifyCalls).toBe(4);
    expect(ledgerRows()).toHaveLength(0);
    expect(getClaimMeter().totals().reserved).toBe(0);
  });
});

describe('concurrency', () => {
  it('N parallel requests against a cap of M never commit more than M', async () => {
    const cap = 20; // two reservations of 8 fit, a third does not
    const key = customer(cap);
    let open!: () => void;
    control.gate = new Promise<void>((resolve) => { open = resolve; });
    // 6 + 3 requests stay under the free tier's 10 per minute burst limit.
    const pending = Array.from({ length: 6 }, () => post('/scan', key.key, { text: sentences(8), provider: ENGINE_PROVIDER }));
    await until(() => control.verifyCalls >= 16, 'the admitted requests to start verifying');
    expect(usage(key.id).reserved).toBe(16);
    open();
    const codes = (await Promise.all(pending)).map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200).length).toBe(2);
    expect(codes.filter((c) => c === 402).length).toBe(4);
    expect(usage(key.id)).toEqual({ used: 16, reserved: 0 });
    expect(ledgerRows().length).toBe(16);
    // More parallel requests, now with 4 remaining: none fits, none commits.
    const more = await Promise.all(Array.from({ length: 3 }, () => post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER })));
    expect(more.every((r) => r.statusCode === 402)).toBe(true);
    expect(usage(key.id).used).toBeLessThanOrEqual(cap);
    const seqs = ledgerRows().map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it('two concurrent requests whose headroom fits one reservation: exactly one proceeds', async () => {
    const key = customer(8); // one /scan reservation (8) fits, two do not
    let open!: () => void;
    control.gate = new Promise<void>((resolve) => { open = resolve; });
    const [a, b] = [post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER }), post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER })];
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
    const first = post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER });
    await until(() => control.verifyCalls === 1, 'the first verify');
    expect(usage(key.id).reserved).toBe(8);
    const second = await post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER });
    expect(second.statusCode).toBe(402);
    expect(second.json()).toEqual(capReached(12, 0, 4));
    open();
    expect((await first).statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 1, reserved: 0 });
  });
});

describe('streaming routes', () => {
  it('GET and POST /scan/stream commit each delivered verdict and end with nothing reserved', async () => {
    const key = customer(100);
    const get = await app.inject({ method: 'GET', url: `/scan/stream?provider=${ENGINE_PROVIDER}&text=${encodeURIComponent(sentences(2))}`, headers: { 'x-api-key': key.key } });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('"type":"complete"');
    expect(usage(key.id)).toEqual({ used: 2, reserved: 0 });

    const res = await post('/scan/stream', key.key, { text: sentences(3), provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 5, reserved: 0 });
    expect(new Set(ledgerRows().map((r) => r.scanId)).size).toBe(2);
  });

  it('a stream over the cap is refused before it opens', async () => {
    const key = customer(3);
    const res = await post('/scan/stream', key.key, { text: sentences(1), provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('claim_cap_reached');
    expect(control.extractCalls).toBe(0);
  });

  it('a stream whose engine fails ends with nothing reserved and nothing billed', async () => {
    control.extractFails = true;
    const key = customer(100);
    const res = await post('/scan/stream', key.key, { text: sentences(2), provider: ENGINE_PROVIDER });
    expect(res.body).toContain('"type":"error"');
    expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });
  });
});

describe('other verifying routes reserve their own maximum', () => {
  it('/scan/batch reserves 8 per text and bills each text', async () => {
    const tight = customer(15);
    const refused = await post('/scan/batch', tight.key, { texts: [sentences(1), sentences(1)], provider: ENGINE_PROVIDER });
    expect(refused.statusCode).toBe(402);
    expect(control.extractCalls).toBe(0);

    const key = customer(16);
    const res = await post('/scan/batch', key.key, { texts: [sentences(1), sentences(2)], provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 3, reserved: 0 });
  });

  it('/scan/diff reserves two scans and bills both', async () => {
    const key = customer(16);
    const res = await post('/scan/diff', key.key, { before: sentences(1), after: sentences(2), provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 3, reserved: 0 });
    expect((await post('/scan/diff', customer(15).key, { before: 'a.', after: 'b.', provider: ENGINE_PROVIDER })).statusCode).toBe(402);
  });

  it('/scan/template/:id meters the template scan', async () => {
    const key = customer(100);
    const tpl = await post('/templates', key.key, { name: 'tpl', provider: ENGINE_PROVIDER });
    expect(tpl.statusCode).toBe(201);
    const res = await post(`/scan/template/${tpl.json().id}`, key.key, { text: sentences(2), provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(200);
    expect(usage(key.id)).toEqual({ used: 2, reserved: 0 });
  });
});

describe('full scan: the estimate reserves nothing, the job reserves its fact claims', () => {
  async function estimate(key: string, n: number) {
    const res = await post('/scan/full/estimate', key, { text: sentences(n), provider: ENGINE_PROVIDER });
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
    const rows = ledgerRows();
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.scanId === jobRecordScanId(jobId))).toBe(true);
  });

  it('a job over the cap is refused with 402 and verifies nothing', async () => {
    const key = customer(2);
    const est = await estimate(key.key, 3);
    const start = await post('/scan/full', key.key, { estimateId: est.estimateId }, { 'idempotency-key': 'idem-meter-0002' });
    expect(start.statusCode).toBe(402);
    expect(start.json()).toEqual(capReached(2, 0, 2));
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
    const enq = await post('/queue/scans', tight.key, { text: sentences(2), provider: ENGINE_PROVIDER });
    expect(enq.statusCode).toBeLessThan(300);
    // Use the headroom up after enqueue, so the run itself must refuse.
    getClaimMeter().commitUsage(tight.id, randomUUID(), [{ claimId: 'x', verdict: 'supported', provider: ENGINE_PROVIDER }], null);
    getScanQueue().tick();
    await until(() => getScanQueue().list(tight.id).every((i) => i.status === 'failed' || i.status === 'completed'), 'the queue item');
    expect(getScanQueue().list(tight.id)[0]).toMatchObject({ status: 'failed', error: 'claim_cap_reached' });
    expect(control.extractCalls).toBe(0);

    const roomy = customer(100);
    await post('/queue/scans', roomy.key, { text: sentences(2), provider: ENGINE_PROVIDER });
    getScanQueue().tick();
    await until(() => usage(roomy.id).used === 2, 'the queued scan to bill');
    expect(usage(roomy.id).reserved).toBe(0);
  });

  it('a submit route answers 402 when the key cannot cover one run', async () => {
    const key = customer(7);
    const routes: Array<[string, object]> = [
      ['/queue/scans', { text: sentences(1), provider: ENGINE_PROVIDER }],
      ['/jobs', { text: sentences(1), provider: ENGINE_PROVIDER, schedule: 'hourly' }],
      ['/schedules', { text: sentences(1), provider: ENGINE_PROVIDER, cron: '0 0 * * 0', name: 'n' }],
    ];
    for (const [url, body] of routes) {
      const res = await post(url, key.key, body);
      expect(res.statusCode, url).toBe(402);
      expect(res.json(), url).toEqual(capReached(7, 0, 7));
    }
    expect(usage(key.id).reserved).toBe(0);
  });

  it('a scheduled job run is metered against its creator', async () => {
    const key = customer(100);
    const created = await post('/jobs', key.key, { text: sentences(2), provider: ENGINE_PROVIDER, schedule: 'hourly' });
    expect(created.statusCode).toBe(201);
    await getJobScheduler().triggerJob(created.json().id);
    expect(usage(key.id)).toEqual({ used: 2, reserved: 0 });
    expect(getJobStore().get(created.json().id)?.runCount).toBe(1);
  });

  it('a schedule run is metered; over the cap it records claim_cap_reached and calls no provider', async () => {
    const key = customer(9);
    const created = await post('/schedules', key.key, { text: sentences(2), provider: ENGINE_PROVIDER, cron: '0 0 * * 0', name: 'weekly' });
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
    await post('/scan', key.key, { text: sentences(2), provider: ENGINE_PROVIDER });
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': key.key } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claims).toEqual({
      period: expect.stringMatching(/^\d{4}-\d{2}$/),
      cap: 20,
      used: 1,
      reserved: 0,
      remaining: 19,
      byVerdict: { supported: 1, contradicted: 0, mixed: 0 },
    });
    expect(body.claimMeter).toBeUndefined();
  });

  it('an unmetered key has no claims block', async () => {
    const key = unmetered();
    const res = await get('/usage', key.key);
    expect(res.statusCode).toBe(200);
    expect(res.json().claims).toBeUndefined();
    expect(res.json().usageRecords).toBeUndefined();
  });

  it('admin sees fleet meter totals and usageRecords, and no per-key claims block', async () => {
    const a = customer(50);
    const b = customer(50);
    await post('/scan', a.key, { text: sentences(2), provider: ENGINE_PROVIDER });
    await post('/scan', b.key, { text: sentences(1), provider: ENGINE_PROVIDER });
    const res = await app.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': SERVER_KEY } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.claims).toBeUndefined();
    expect(body.claimMeter).toMatchObject({
      enabled: true,
      used: 3,
      reserved: 0,
      keys: 2,
      byVerdict: { supported: 3, contradicted: 0, mixed: 0 },
      ledgerWriteFailures: 0,
      refusedIdentifiers: 0,
    });
    expect(body.claimMeter.sync).toBeUndefined();
    expect(body.usageRecords).toEqual({ ledgerId: expect.stringMatching(/^[0-9a-f-]{36}$/), lastSeq: 3, rowsThisPeriod: 3 });
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

describe('a queued full scan re-checks its metered key when it starts', () => {
  const revocations: Array<{ name: string; revoke: (id: string) => void }> = [
    { name: 'deleted', revoke: (id) => { getKeyStore().delete(id); } },
    { name: 'disabled', revoke: (id) => { getKeyStore().disable(id); } },
    { name: 'expired', revoke: (id) => { getKeyStore().update(id, { expiresAt: new Date(Date.now() - 1000).toISOString() }); } },
  ];

  for (const { name, revoke } of revocations) {
    it(`a key ${name} while its job waits: the job fails key_revoked, calls no provider, commits nothing, releases its reservation`, async () => {
      process.env.FAULTLINE_FULL_MAX_RUNNING = '1';
      const a = customer(100);
      const b = customer(100);
      const estA = await post('/scan/full/estimate', a.key, { text: sentences(1), provider: ENGINE_PROVIDER });
      const estB = await post('/scan/full/estimate', b.key, { text: sentences(1), provider: ENGINE_PROVIDER });
      expect(estA.statusCode).toBe(200);
      expect(estB.statusCode).toBe(200);

      // A holds the only running slot.
      let open!: () => void;
      control.gate = new Promise<void>((resolve) => { open = resolve; });
      const startA = await post('/scan/full', a.key, { estimateId: estA.json().estimateId }, { 'idempotency-key': `idem-rev-a-${name}` });
      expect(startA.statusCode).toBe(202);
      await until(() => control.verifyCalls >= 1, 'A to start verifying');

      // B queues behind it, holding its one-claim reservation.
      const startB = await post('/scan/full', b.key, { estimateId: estB.json().estimateId }, { 'idempotency-key': `idem-rev-b-${name}` });
      expect(startB.statusCode).toBe(202);
      const jobB = startB.json().jobId as string;
      const queuedB = getFullScanJobStore().lookup(jobB, b.id);
      expect(queuedB.kind).toBe('job');
      expect((queuedB as { job: { status: string } }).job.status).toBe('queued');
      expect(usage(b.id)).toEqual({ used: 0, reserved: 1 });

      revoke(b.id);
      const verifyBefore = control.verifyCalls;
      const extractBefore = control.extractCalls;
      open();

      await until(() => {
        const found = getFullScanJobStore().lookup(jobB, b.id);
        return found.kind === 'job' && found.job.status === 'failed';
      }, 'B to fail');
      await until(() => usage(a.id).reserved === 0, 'A to settle');

      const found = getFullScanJobStore().lookup(jobB, b.id);
      expect(found.kind).toBe('job');
      const view = describeJob((found as { job: Parameters<typeof describeJob>[0] }).job);
      expect(view.status).toBe('failed');
      expect(view.progress.length).toBe(1);
      expect(view.progress.map((p) => p.reason)).toEqual(['key_revoked']);
      expect(control.verifyCalls).toBe(verifyBefore);
      expect(control.extractCalls).toBe(extractBefore);
      const rowsB = ledgerRows().filter((r) => r.keyId === b.id);
      expect(rowsB).toEqual([]);
      expect(usage(b.id)).toEqual({ used: 0, reserved: 0 });
      // A, still live, ran and billed its claim.
      expect(ledgerRows().filter((r) => r.keyId === a.id).length).toBe(1);
    });
  }
});

describe('only FAULTLINE_CLAIM_METER=1 turns the meter on', () => {
  for (const value of ['on', 'true', 'yes', '0', '']) {
    it(`FAULTLINE_CLAIM_METER=${JSON.stringify(value)} is off: a metered key with claimCap 0 scans with 200`, async () => {
      process.env.FAULTLINE_CLAIM_METER = value;
      const key = customer(0);
      const res = await post('/scan', key.key, { text: sentences(2), provider: ENGINE_PROVIDER });
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json().verifications ?? {}).length).toBe(2);
      expect(existsSync(ledgerPath())).toBe(false);
      expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });
    });
  }

  for (const value of ['1', ' 1 ']) {
    it(`FAULTLINE_CLAIM_METER=${JSON.stringify(value)} is on: a metered key with claimCap 0 gets 402 claim_cap_reached`, async () => {
      process.env.FAULTLINE_CLAIM_METER = value;
      const key = customer(0);
      const res = await post('/scan', key.key, { text: sentences(2), provider: ENGINE_PROVIDER });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toEqual(capReached(0, 0, 0));
      expect(control.verifyCalls).toBe(0);
    });
  }
});

describe('switched off, or an unmetered key: behaviour as before the meter', () => {
  type Family = { name: string; run: (key: string) => Promise<{ statusCode: number; verified: number }> };
  const families: Family[] = [
    { name: 'POST /scan', run: async (key) => {
      const res = await post('/scan', key, { text: sentences(2), provider: ENGINE_PROVIDER });
      return { statusCode: res.statusCode, verified: Object.keys(res.json().verifications ?? {}).length };
    } },
    { name: 'POST /scan/stream', run: async (key) => {
      const res = await post('/scan/stream', key, { text: sentences(2), provider: ENGINE_PROVIDER });
      return { statusCode: res.statusCode, verified: res.body.split('"type":"claim_verified"').length - 1 };
    } },
    { name: 'POST /scan/batch', run: async (key) => {
      const res = await post('/scan/batch', key, { texts: [sentences(1), sentences(1)], provider: ENGINE_PROVIDER });
      return { statusCode: res.statusCode, verified: control.verifyCalls };
    } },
    { name: 'POST /scan/full', run: async (key) => {
      const est = await post('/scan/full/estimate', key, { text: sentences(2), provider: ENGINE_PROVIDER });
      const start = await post('/scan/full', key, { estimateId: est.json().estimateId }, { 'idempotency-key': `idem-off-${randomUUID()}` });
      await until(() => control.verifyCalls >= 2, 'the job');
      return { statusCode: start.statusCode, verified: control.verifyCalls };
    } },
    { name: 'POST /queue/scans (background)', run: async (key) => {
      const res = await post('/queue/scans', key, { text: sentences(2), provider: ENGINE_PROVIDER });
      getScanQueue().tick();
      await until(() => control.verifyCalls >= 2, 'the queued scan');
      return { statusCode: res.statusCode, verified: control.verifyCalls };
    } },
  ];

  const expected: Record<string, number> = {
    'POST /scan': 200, 'POST /scan/stream': 200, 'POST /scan/batch': 200, 'POST /scan/full': 202, 'POST /queue/scans (background)': 202,
  };

  for (const family of families) {
    it(`${family.name}: an unmetered key with the meter on is never refused or recorded`, async () => {
      const key = unmetered(); // claimCap 0, but not metered: the cap is ignored
      const out = await family.run(key.key);
      expect(out.statusCode).toBe(expected[family.name]);
      expect(out.verified).toBeGreaterThan(0);
      expect(existsSync(ledgerPath())).toBe(false);
      expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });
    });

    it(`${family.name}: with FAULTLINE_CLAIM_METER unset a metered key is never refused or recorded`, async () => {
      delete process.env.FAULTLINE_CLAIM_METER;
      const key = customer(0);
      const out = await family.run(key.key);
      expect(out.statusCode).toBe(expected[family.name]);
      expect(out.verified).toBeGreaterThan(0);
      expect(existsSync(ledgerPath())).toBe(false);
      expect(usage(key.id)).toEqual({ used: 0, reserved: 0 });
      const me = await get('/usage', key.key);
      expect(me.json().claims).toBeUndefined();
    });
  }
});

describe('GET /admin/usage-records', () => {
  async function seed(n: number) {
    const key = customer(1_000, 'cus_Seed1');
    for (let i = 0; i < n; i++) expect((await post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER })).statusCode).toBe(200);
    return key;
  }

  it('pages with after/limit in seq order, with nextAfter, hasMore and the version header', async () => {
    await seed(5);
    const first = await get('/admin/usage-records?limit=2', SERVER_KEY);
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-usage-record-version']).toBe('1');
    const p1 = first.json();
    expect(p1.records.length).toBe(2);
    expect(p1).toMatchObject({ ledgerId: expect.stringMatching(/^[0-9a-f-]{36}$/), nextAfter: 2, hasMore: true });
    expect(p1.records.map((r: UsageRecord) => r.seq)).toEqual([1, 2]);
    expect(Object.keys(p1.records[0]).sort()).toEqual(
      ['claimId', 'identifier', 'keyId', 'kind', 'period', 'provider', 'scanId', 'seq', 'stripeCustomerId', 'ts', 'verdict'].sort());
    expect(p1.records[0].stripeCustomerId).toBe('cus_Seed1');

    const p2 = (await get(`/admin/usage-records?after=${p1.nextAfter}&limit=2`, SERVER_KEY)).json();
    expect(p2.records.map((r: UsageRecord) => r.seq)).toEqual([3, 4]);
    const p3 = (await get(`/admin/usage-records?after=${p2.nextAfter}&limit=2`, SERVER_KEY)).json();
    expect(p3.records.map((r: UsageRecord) => r.seq)).toEqual([5]);
    expect(p3).toMatchObject({ nextAfter: 5, hasMore: false, ledgerId: p1.ledgerId });
  });

  it('defaults to after=0 and limit=500, and refuses a limit outside 1..1000', async () => {
    await seed(1);
    const res = await get('/admin/usage-records', SERVER_KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json().records.length).toBe(1);
    for (const q of ['limit=0', 'limit=1001', 'after=-1', 'limit=abc']) {
      expect((await get(`/admin/usage-records?${q}`, SERVER_KEY)).statusCode, q).toBe(400);
    }
  });

  it('needs scope usage:read: a key without it gets 403, a scoped key and admin pass', async () => {
    await seed(1);
    const plain = getKeyStore().create('plain', ['scan']);
    const other = getKeyStore().create('other', ['scan'], undefined, { scopes: ['keys:write'] });
    const reader = getKeyStore().create('reader', ['scan'], undefined, { scopes: ['usage:read'] });
    const admin = getKeyStore().create('ops', ['admin']);
    for (const key of [plain, other]) {
      const res = await get('/admin/usage-records', key.key);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'scope_required', scope: 'usage:read' });
    }
    expect((await get('/admin/usage-records', reader.key)).statusCode).toBe(200);
    expect((await get('/admin/usage-records', admin.key)).statusCode).toBe(200);
    expect((await get('/admin/usage-records', SERVER_KEY)).statusCode).toBe(200);
    expect((await get('/admin/usage-records', 'not-a-key')).statusCode).toBe(401);
  });

  it('never changes state: the file, the record and the counts are the same after many reads', async () => {
    const key = await seed(2);
    const before = readFileSync(ledgerPath(), 'utf8');
    expect(before.length).toBeGreaterThan(0);
    const status = getClaimMeter().status();
    for (let i = 0; i < 5; i++) await get('/admin/usage-records?after=0&limit=1', SERVER_KEY);
    expect(readFileSync(ledgerPath(), 'utf8')).toBe(before);
    expect(getClaimMeter().status()).toEqual(status);
    expect(usage(key.id)).toEqual({ used: 2, reserved: 0 });
  });

  it('on a fresh volume answers an empty page and creates no file, also with the meter off', async () => {
    delete process.env.FAULTLINE_CLAIM_METER;
    const res = await get('/admin/usage-records', SERVER_KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ledgerId: null, records: [], nextAfter: 0, hasMore: false });
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it('a reader polling during concurrent commits never sees a gap', async () => {
    const key = customer(10_000);
    const seen: number[][] = [];
    let done = false;
    const reader = (async () => {
      while (!done) {
        seen.push((await get('/admin/usage-records?limit=1000', SERVER_KEY)).json().records.map((r: UsageRecord) => r.seq));
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await Promise.all(Array.from({ length: 6 }, () => post('/scan/stream', key.key, { text: sentences(4), provider: ENGINE_PROVIDER })));
    done = true;
    await reader;
    seen.push((await get('/admin/usage-records?limit=1000', SERVER_KEY)).json().records.map((r: UsageRecord) => r.seq));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1].length).toBe(24);
    for (const page of seen) expect(page).toEqual(Array.from({ length: page.length }, (_, i) => i + 1));
  });
});

describe('POST /keys Idempotency-Key', () => {
  const create = (headers: Record<string, string>, body: object = { name: 'cust', permissions: ['scan'], metered: true, claimCap: 100 }) =>
    post('/keys', SERVER_KEY, body, headers);

  it('the first call mints (201); a replay returns the same keyId with key null and 200', async () => {
    const first = await create({ 'idempotency-key': 'billing-sub-0001' });
    expect(first.statusCode).toBe(201);
    const minted = first.json();
    expect(typeof minted.key).toBe('string');
    expect(minted.key.length).toBeGreaterThan(0);
    const replay = await create({ 'idempotency-key': 'billing-sub-0001' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: minted.id, key: null, metered: true, claimCap: 100 });
    expect(JSON.stringify(replay.json())).not.toContain(minted.key);
    expect(getKeyStore().list().length).toBe(1);
  });

  it('the map survives a keystore reload (it is kept on the ledger volume)', async () => {
    const first = await create({ 'idempotency-key': 'billing-sub-0002' });
    expect(first.statusCode).toBe(201);
    const id = first.json().id as string;
    const raw = readFileSync(process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER as string, 'utf8');
    expect(raw).toContain(id);
    expect(raw).not.toContain('billing-sub-0002'); // a hash of the header value, never the value
    expect(raw).not.toContain(first.json().key);
    resetKeyStore(); // what a deploy does to the in-memory keystore
    const replay = await create({ 'idempotency-key': 'billing-sub-0002' });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ id, key: null });
    expect(getKeyStore().list().length).toBe(0);
  });

  it('a different value mints a different key; no header mints every time', async () => {
    const a = await create({ 'idempotency-key': 'billing-sub-A' });
    const b = await create({ 'idempotency-key': 'billing-sub-B' });
    const c = await create({});
    const d = await create({});
    expect(new Set([a, b, c, d].map((r) => r.json().id)).size).toBe(4);
  });

  it('refuses an empty value and one longer than 200 characters', async () => {
    expect((await create({ 'idempotency-key': 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await create({ 'idempotency-key': '' })).statusCode).toBe(400);
    expect((await create({ 'idempotency-key': 'x'.repeat(200) })).statusCode).toBe(201);
  });

  it('rotate issues a fresh plaintext key for the minted keyId', async () => {
    const first = await create({ 'idempotency-key': 'billing-sub-0003' });
    const id = first.json().id as string;
    const rotated = await post(`/keys/${id}/rotate`, SERVER_KEY, {});
    expect(rotated.statusCode).toBe(200);
    const newKey = rotated.json().newKey as string;
    expect(typeof newKey).toBe('string');
    expect(newKey).not.toBe(first.json().key);
    expect((await create({ 'idempotency-key': 'billing-sub-0003' })).json()).toMatchObject({ id, key: null });
  });
});

describe('key binding fields and scopes', () => {
  it('admin sets metered, claimCap, stripeCustomerId and scopes on POST and PATCH', async () => {
    const created = await post('/keys', SERVER_KEY, { name: 'cust', permissions: ['scan'], metered: true, claimCap: 5, stripeCustomerId: 'cus_A1', scopes: ['usage:read'] });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ metered: true, claimCap: 5, stripeCustomerId: 'cus_A1', scopes: ['usage:read'] });
    const id = created.json().id as string;
    const patched = await app.inject({ method: 'PATCH', url: `/keys/${id}`, headers: { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' }, payload: { metered: false, scopes: [] } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ metered: false, scopes: [] });
  });

  it('refuses an unknown scope and a non-boolean metered', async () => {
    for (const body of [{ scopes: ['root'] }, { scopes: ['usage:read', 'usage:read'] }, { metered: 'yes' }]) {
      expect((await post('/keys', SERVER_KEY, { name: 'x', permissions: ['scan'], ...body })).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('a non-admin key, even one holding keys:write, cannot set binding fields or grant scopes', async () => {
    const writer = getKeyStore().create('writer', ['scan'], undefined, { scopes: ['keys:write'] });
    const target = customer(1);
    for (const payload of [{ claimCap: 1_000_000 }, { metered: false }, { scopes: ['usage:read'] }]) {
      const res = await app.inject({ method: 'PATCH', url: `/keys/${target.id}`, headers: { 'x-api-key': writer.key, 'content-type': 'application/json' }, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(403);
    }
    expect((await post('/keys', writer.key, { name: 'x', permissions: ['scan'], scopes: ['usage:read'] })).statusCode).toBe(403);
    expect(getKeyStore().validateById(target.id)).toMatchObject({ claimCap: 1, metered: true });
    expect(getKeyStore().validateById(target.id)?.scopes).toBeUndefined();
  });
});

describe('stripeCustomerId is copied at commit time', () => {
  it('rebinding a key after a commit does not change the earlier row', async () => {
    const key = customer(100, 'cus_Before1');
    expect((await post('/scan', key.key, { text: sentences(1), provider: ENGINE_PROVIDER })).statusCode).toBe(200);
    const patched = await app.inject({ method: 'PATCH', url: `/keys/${key.id}`, headers: { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' }, payload: { stripeCustomerId: 'cus_After1' } });
    expect(patched.statusCode).toBe(200);
    expect((await post('/scan', key.key, { text: sentences(2), provider: ENGINE_PROVIDER })).statusCode).toBe(200);
    const records = (await get('/admin/usage-records', SERVER_KEY)).json().records as UsageRecord[];
    expect(records.length).toBe(3);
    expect(records.map((r) => r.stripeCustomerId)).toEqual(['cus_Before1', 'cus_After1', 'cus_After1']);
  });
});

describe('voids: a full-scan result its owner can never see', () => {
  async function finishedJob(key: { key: string; id: string }, n: number, idem: string): Promise<string> {
    const est = await post('/scan/full/estimate', key.key, { text: sentences(n), provider: ENGINE_PROVIDER });
    expect(est.statusCode).toBe(200);
    const start = await post('/scan/full', key.key, { estimateId: est.json().estimateId }, { 'idempotency-key': idem });
    expect(start.statusCode).toBe(202);
    const jobId = start.json().jobId as string;
    await until(() => usage(key.id).used === n && usage(key.id).reserved === 0, 'the job to commit');
    return jobId;
  }

  /** What a deploy does: memory is gone, the ledgers are reloaded. */
  function restart(): void {
    resetFullScanJobStore();
    resetClaimMeter();
  }

  const voidRows = () => ledgerRows().filter((r) => r.kind === 'void');

  it('an unserved job read after a restart (resultAvailable false) writes voids once and used drops', async () => {
    const key = customer(100);
    const jobId = await finishedJob(key, 3, 'idem-void-0001');
    expect(ledgerRows().length).toBe(3);
    restart();
    expect(usage(key.id).used).toBe(3);
    const after = await get(`/scan/full/${jobId}`, key.key);
    expect(after.statusCode).toBe(200);
    expect(after.json().resultAvailable).toBe(false);
    const voids = voidRows();
    expect(voids.length).toBe(3);
    expect(voids.map((v) => v.voids)).toEqual(ledgerRows().filter((r) => r.kind === 'usage').map((r) => r.identifier));
    expect(voids[0].identifier).toBe(`void:${voids[0].voids}`);
    expect(usage(key.id).used).toBe(0);
    // Once: a second read, and a read after another restart, write nothing more.
    await get(`/scan/full/${jobId}`, key.key);
    restart();
    await get(`/scan/full/${jobId}`, key.key);
    expect(voidRows().length).toBe(3);
    expect(usage(key.id).used).toBe(0);
  });

  it('a job whose result was served is never voided, across a restart', async () => {
    const key = customer(100);
    const jobId = await finishedJob(key, 2, 'idem-void-0002');
    const served = await get(`/scan/full/${jobId}`, key.key);
    expect(served.statusCode).toBe(200);
    expect(served.json().progress.filter((p: { status: string }) => p.status === 'served').length).toBe(2);
    restart();
    const after = await get(`/scan/full/${jobId}`, key.key);
    expect(after.json().resultAvailable).toBe(false);
    expect(voidRows()).toEqual([]);
    expect(usage(key.id).used).toBe(2);
  });

  it('another key reading the job id voids nothing', async () => {
    const key = customer(100);
    const jobId = await finishedJob(key, 2, 'idem-void-0003');
    restart();
    const stranger = customer(100);
    expect((await get(`/scan/full/${jobId}`, stranger.key)).statusCode).toBe(404);
    expect(voidRows()).toEqual([]);
    expect(usage(key.id).used).toBe(2);
  });

  it('job_lost for an unserved job (its terminal row never reached the disk) voids its committed rows', async () => {
    const key = customer(100);
    const est = await post('/scan/full/estimate', key.key, { text: sentences(2), provider: ENGINE_PROVIDER });
    let open!: () => void;
    control.gate = new Promise<void>((resolve) => { open = resolve; });
    const start = await post('/scan/full', key.key, { estimateId: est.json().estimateId }, { 'idempotency-key': 'idem-void-0004' });
    const jobId = start.json().jobId as string;
    await until(() => control.verifyCalls >= 2, 'the job to verify');
    setFullScanLedgerAppendForTests(() => { throw new Error('disk full'); });
    open();
    await until(() => usage(key.id).used === 2, 'the job to commit');
    setFullScanLedgerAppendForTests(null);
    restart();
    const lost = await get(`/scan/full/${jobId}`, key.key);
    expect(lost.statusCode).toBe(404);
    expect(lost.json()).toEqual({ error: 'job_lost' });
    expect(voidRows().length).toBe(2);
    expect(usage(key.id).used).toBe(0);
  });

  it('with the meter off, polling an unserved job after a restart appends nothing and changes no counts', async () => {
    const key = customer(100);
    const jobId = await finishedJob(key, 3, 'idem-void-0005');
    const before = readFileSync(ledgerPath(), 'utf8');
    expect(ledgerRows().length).toBe(3);
    restart();
    delete process.env.FAULTLINE_CLAIM_METER;
    const statusBefore = getClaimMeter().status();
    const usedBefore = getClaimMeter().usageFor(key.id).used;
    expect(usedBefore).toBe(3);
    const after = await get(`/scan/full/${jobId}`, key.key);
    expect(after.statusCode).toBe(200);
    expect(after.json().resultAvailable).toBe(false);
    expect(readFileSync(ledgerPath(), 'utf8')).toBe(before);
    expect(voidRows()).toEqual([]);
    expect(getClaimMeter().status()).toEqual(statusBefore);
    expect(getClaimMeter().usageFor(key.id).used).toBe(usedBefore);
  });
});
