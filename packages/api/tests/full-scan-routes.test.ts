// Validates: GoPMO 1.18.11.3.12 (full-scan API)
/**
 * Full scan ("deep scan") routes, end to end through Fastify inject:
 * POST /scan/full/estimate, POST /scan/full, GET /scan/full/:jobId,
 * POST /scan/full/:jobId/stop, and the admin refund report on GET /usage.
 *
 * Contract: docs/design/2026-10-13-full-scan-api.md §3–§7. Units: charged =
 * ceil(fact claims / 8) at the estimate; served = ceil(claims with a billable
 * verdict / 8); refund = charged - served. A billable verdict is supported,
 * contradicted or mixed, with at least one source, a retriever the engine
 * bound, and no apiError.
 *
 * The provider registry is wrapped, not replaced: by default every call reaches
 * the REAL 'mock' provider (one fact claim per sentence, all supported). The mock
 * cites no source, so by default each of its verdicts gets one source added here;
 * `control.rawMock` turns that off. The mock has no engine retriever, so jobs
 * are estimated under the provider id 'gemini' (ENGINE_PROVIDER), which the
 * wrapper answers with the real mock, reported (test-only, through this module
 * mock) as the built-in gemini instance: the engine then binds
 * 'gemini-grounding' and a sourced verdict is billable. No real Gemini call is
 * made. A
 * test that needs to
 * hold claims in flight, fail claims or tag opinions swaps in a fixture provider
 * for that test only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult, ApiErrorReason } from '@nxtg/faultline/types.js';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter, getUsageMeter } from '../src/store/usage.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { getCostStore, resetCostStore } from '../src/store/costs.js';
import {
  getFullScanJobStore,
  resetFullScanJobStore,
  setFullScanLedgerAppendForTests,
  newJobId,
  type FullScanLedgerRow,
} from '../src/store/full-scan-jobs.js';
import { resetFullScanEstimateLimiter } from '../src/routes/full-scan.js';

const control = vi.hoisted(() => ({
  /** When set, getProvider returns this instead of the real registry's provider. */
  provider: null as null | (() => unknown),
  /** When true, getProvider throws: the job's verify run fails outright. */
  failGetProvider: false,
  /** When true, the real mock's verdicts are passed on as given, with no source. */
  rawMock: false,
}));

/** The provider id jobs run under; see the header. */
const ENGINE_PROVIDER = 'gemini';

/** The one source the default adds to each real mock verdict. */
const MOCK_SOURCE = { title: 'Fixture source', uri: 'https://example.org/fixture' };

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  // Test-only: a fixture resolved under a built-in id stands in for that
  // built-in's own instance, which the real registry records for its factories.
  const standIns = new WeakMap<object, string>();
  const standIn = <T,>(name: string | undefined, p: T): T => {
    if (name !== undefined && actual.isBuiltInProviderName(name) && p && typeof p === 'object') standIns.set(p, name);
    return p;
  };
  return {
    ...actual,
    builtInProviderIdOf: vi.fn((p: unknown) => (p && typeof p === 'object' ? standIns.get(p) : undefined) ?? actual.builtInProviderIdOf(p)),
    getProvider: vi.fn((apiKey: string, name?: string) => {
      if (control.failGetProvider) throw new Error('provider construction failed');
      if (control.provider) return standIn(name, control.provider());
      // Under the engine's id the fixture stands in for the built-in gemini
      // instance, so the engine grants its retriever; the real mock still answers.
      const real = actual.getProvider(apiKey, name === ENGINE_PROVIDER ? 'mock' : name);
      if (control.rawMock) return standIn(name, real);
      // The mock is a class instance, so its other methods are kept through the prototype.
      return standIn(name, Object.assign(Object.create(real), {
        verifyClaim: async (claim: Claim) => {
          const verdict = await real.verifyClaim(claim);
          return verdict.sources.length === 0 ? { ...verdict, sources: [MOCK_SOURCE] } : verdict;
        },
      }));
    }),
  };
});

const SERVER_KEY = 'test-full-scan-server-key';
const ENV_KEYS = [
  'GEMINI_API_KEY',
  'FAULTLINE_API_KEY',
  'FAULTLINE_FULL_JOBS_LEDGER',
  'FAULTLINE_FULL_MAX_RUNNING',
  'FAULTLINE_FULL_ESTIMATE_PER_MIN',
  'FAULTLINE_PROVIDER_SPEND_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_USAGE_CAP',
  'FAULTLINE_CAP_FREE',
];
const USER_A = 'a'.repeat(64);
const USER_B = 'b'.repeat(64);
const LEDGER_FIELDS = [
  'estimateId', 'factClaims', 'finishedAt', 'idempotencyKey', 'jobId', 'keyId', 'reasons', 'servedClaims', 'status',
  'units', 'unserved', 'verdicts',
];

type Json = Record<string, any>;

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let ledgerFile: string;
let server: FastifyInstance;

// ── Fixtures ────────────────────────────────────────────────────────────────

/** `n` sentences; the mock provider extracts one fact claim per sentence (c1..cn). */
function sentences(n: number, tag = 'fact'): string {
  return Array.from({ length: n }, (_, i) => `Sentence ${i + 1} states a checkable ${tag}.`).join(' ');
}

/** A billable verdict: supported with one source. */
function supported(claim: Claim): VerificationResult {
  return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: [MOCK_SOURCE] };
}

function apiError(claim: Claim, reason: ApiErrorReason): VerificationResult {
  return { claimId: claim.id, status: 'unverified', explanation: 'Verify failed after retries.', sources: [], apiError: true, apiErrorReason: reason };
}

/**
 * A provider like the mock (one claim per sentence) whose sentences containing
 * "opinion" are opinions, with a swappable verify.
 */
function useFixtureProvider(verify: (claim: Claim) => Promise<VerificationResult>) {
  const verifyClaim = vi.fn(verify);
  control.provider = () => ({
    name: 'Fixture Provider',
    modelId: 'fixture-v1',
    extractClaims: async (text: string): Promise<Claim[]> =>
      text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).map((s, i) => ({
        id: `c${i + 1}`, text: s, type: /opinion/.test(s) ? 'opinion' : 'fact', importance: 3,
      })),
    verifyClaim,
    generateCritiqueAndPrompt: vi.fn(),
  });
  return verifyClaim;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Holds every verify call in flight until released; counts the most ever in flight. */
function useGatedProvider() {
  const waiting: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const verifyClaim = useFixtureProvider(async (claim) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => waiting.push(resolve));
    inFlight -= 1;
    return supported(claim);
  });
  return {
    verifyClaim,
    inFlight: () => inFlight,
    maxInFlight: () => maxInFlight,
    async release(n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        waiting.shift()?.();
        await flush();
      }
      await flush();
    },
    async releaseAll(): Promise<void> {
      while (waiting.length > 0) {
        waiting.shift()?.();
        await flush();
      }
      await flush();
    },
  };
}

let openGates: Array<{ releaseAll: () => Promise<void> }> = [];

function gated() {
  const gate = useGatedProvider();
  openGates.push(gate);
  return gate;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

interface Caller {
  key?: string;
  userRef?: string;
  headers?: Record<string, string>;
}

function headersFor(caller: Caller = {}): Record<string, string> {
  const headers: Record<string, string> = { 'x-api-key': caller.key ?? SERVER_KEY, ...caller.headers };
  if (caller.userRef !== undefined) headers['x-faultline-user-ref'] = caller.userRef;
  return headers;
}

async function call(method: 'GET' | 'POST', url: string, caller: Caller = {}, body?: Json) {
  const headers = headersFor(caller);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await server.inject({ method, url, headers, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { statusCode: res.statusCode, json: JSON.parse(res.body) as Json };
}

const estimate = (text: string, caller: Caller = {}, extra: Json = {}) =>
  call('POST', '/scan/full/estimate', caller, { text, provider: ENGINE_PROVIDER, ...extra });

const start = (estimateId: string, idempotencyKey: string | undefined, caller: Caller = {}, extra: Json = {}) =>
  call('POST', '/scan/full', {
    ...caller,
    headers: { ...caller.headers, ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}) },
  }, { estimateId, ...extra });

const poll = (jobId: string, caller: Caller = {}) => call('GET', `/scan/full/${jobId}`, caller);
const stop = (jobId: string, caller: Caller = {}) => call('POST', `/scan/full/${jobId}/stop`, caller);

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const TERMINAL = new Set(['done', 'stopped', 'failed']);

async function untilTerminal(jobId: string, caller: Caller = {}, timeoutMs?: number): Promise<Json> {
  let last: Json = {};
  await waitFor(async () => {
    last = (await poll(jobId, caller)).json;
    return TERMINAL.has(last.status);
  }, timeoutMs);
  return last;
}

/** Estimate then start; returns the job id. */
async function startJob(text: string, idempotencyKey: string, caller: Caller = {}): Promise<string> {
  const est = await estimate(text, caller);
  expect(est.statusCode).toBe(200);
  const started = await start(est.json.estimateId, idempotencyKey, caller);
  expect(started.statusCode).toBe(202);
  return started.json.jobId;
}

function ledgerRows(): FullScanLedgerRow[] {
  if (!existsSync(ledgerFile)) return [];
  return readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FullScanLedgerRow);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'full-scan-'));
  ledgerFile = join(tmpDir, 'full-scan-jobs.jsonl');
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  // Key resolution needs a value for 'gemini'; the wrapped registry never uses it.
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.FAULTLINE_FULL_JOBS_LEDGER = ledgerFile;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  delete process.env.FAULTLINE_FULL_MAX_RUNNING;
  delete process.env.FAULTLINE_FULL_ESTIMATE_PER_MIN;
  delete process.env.FAULTLINE_PROVIDER_SPEND_CAP;
  delete process.env.FAULTLINE_USAGE_CAP;
  delete process.env.FAULTLINE_CAP_FREE;
  control.provider = null;
  control.failGetProvider = false;
  control.rawMock = false;
  openGates = [];
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCostStore();
  resetProviderSpendLedger();
  resetFullScanJobStore();
  resetFullScanEstimateLimiter();
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  setFullScanLedgerAppendForTests(null);
  for (const gate of openGates) await gate.releaseAll();
  resetFullScanJobStore();
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('full lifecycle on the real mock provider', () => {
  it('estimate -> start -> poll until done', async () => {
    const est = await estimate(sentences(10));
    expect(est.statusCode).toBe(200);
    expect(est.json.estimateId).toMatch(/^fse_[0-9a-f]{32}$/);
    expect(est.json).toMatchObject({ factClaims: 10, notCheckable: 0, units: 2 });
    expect(est.json.claims).toHaveLength(10);
    expect(est.json.claims[0]).toEqual({ claimId: 'c1', text: expect.any(String) });
    expect(est.json.claims[0].text.length).toBeGreaterThan(0);
    expect(est.json.claims.map((c: Json) => c.claimId)).toEqual(Array.from({ length: 10 }, (_, i) => `c${i + 1}`));
    const ttl = Date.parse(est.json.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);

    const started = await start(est.json.estimateId, 'idem-lifecycle');
    expect(started.statusCode).toBe(202);
    expect(started.json.jobId).toMatch(/^fsj_[0-9a-z]+_[0-9a-f]{32}$/);
    expect(started.json).toMatchObject({ units: 2, factClaims: 10 });

    const done = await untilTerminal(started.json.jobId);
    expect(done.status).toBe('done');
    expect(done).toMatchObject({ factClaims: 10, checked: 10, failed: 0, unserved: [], resultAvailable: true });
    expect(done.units).toEqual({ charged: 2, served: 2, refund: 0 });
    expect(done.progress).toHaveLength(10);
    expect(done.progress.map((p: Json) => p.claimId)).toEqual(Array.from({ length: 10 }, (_, i) => `c${i + 1}`));
    for (const p of done.progress) {
      expect(p.status).toBe('served');
      expect(p.verdict.status).toBe('supported');
    }
    expect(done.result.verification).toMatchObject({ mode: 'full', factClaims: 10, servedClaims: 10 });
    expect(Object.keys(done.result.verifications)).toHaveLength(10);
  });

  it('verdicts appear in progress as they land, and units grow with them', async () => {
    const gate = gated();
    const jobId = await startJob(sentences(10), 'idem-progressive');
    await gate.release(0);

    const before = (await poll(jobId)).json;
    expect(before.status).toBe('running');
    expect(before.checked).toBe(0);
    expect(before.progress.every((p: Json) => p.status === 'pending' && p.verdict === undefined)).toBe(true);
    expect(before.result).toBeUndefined();

    await gate.release(3);
    const mid = (await poll(jobId)).json;
    expect(mid.status).toBe('running');
    expect(mid.checked).toBe(3);
    const served = mid.progress.filter((p: Json) => p.status === 'served');
    expect(served).toHaveLength(3);
    expect(served.every((p: Json) => p.verdict?.status === 'supported')).toBe(true);
    expect(mid.progress.filter((p: Json) => p.status === 'pending')).toHaveLength(7);
    expect(mid.units).toEqual({ charged: 2, served: 1, refund: 1 });
    expect(mid.unserved).toEqual([]);

    await gate.releaseAll();
    const done = await untilTerminal(jobId);
    expect(done.status).toBe('done');
    expect(done.units).toEqual({ charged: 2, served: 2, refund: 0 });
  });

  it('opinions are not checkable: counted at the estimate, never verified, absent from progress', async () => {
    const verifyClaim = useFixtureProvider(async (c) => supported(c));
    const text = 'Paris is the capital of France. In my opinion Paris is lovely. Water boils at 100 C at sea level.';
    const est = await estimate(text);
    expect(est.json).toMatchObject({ factClaims: 2, notCheckable: 1, units: 1 });
    expect(est.json.claims.map((c: Json) => c.claimId)).toEqual(['c1', 'c3']);

    const started = await start(est.json.estimateId, 'idem-opinion');
    const done = await untilTerminal(started.json.jobId);
    expect(verifyClaim).toHaveBeenCalledTimes(2);
    expect(done.progress.map((p: Json) => p.claimId)).toEqual(['c1', 'c3']);
    expect(done.result.verification.notCheckableClaimIds).toEqual(['c2']);
  });

  it('logs the estimate and the run as kind full-scan, outside the scan percentiles, and meters the job once', async () => {
    const jobId = await startJob(sentences(3), 'idem-cost');
    await untilTerminal(jobId);

    const events = getCostStore().getManagedEvents().filter((e) => e.kind === 'full-scan');
    expect(events).toHaveLength(2);
    expect(events[1].groundingCalls).toBe(3);
    expect(getCostStore().getPercentiles().count).toBe(0);
    expect(getUsageMeter().getMonthlyCount('admin')).toBe(1);
  });

  it('a job is counted once when it is admitted, even when it serves no billable verdict', async () => {
    useFixtureProvider(async (c) => apiError(c, 'provider_unavailable'));
    const jobId = await startJob(sentences(3), 'idem-unbilled');
    const done = await untilTerminal(jobId);
    expect(done.progress.length).toBeGreaterThan(0);
    expect(done.units.served).toBe(0);
    expect(getUsageMeter().getMonthlyCount('admin')).toBe(1);
  });
});

describe('units and unserved claims', () => {
  it('31 facts, 11 lost to provider errors: units {4, 3, 1}, each unserved claim carries its reason', async () => {
    const reasons = new Map<string, ApiErrorReason>();
    for (let i = 21; i <= 26; i++) reasons.set(`c${i}`, 'rate_limited');
    for (let i = 27; i <= 31; i++) reasons.set(`c${i}`, 'provider_unavailable');
    useFixtureProvider(async (c) => (reasons.has(c.id) ? apiError(c, reasons.get(c.id)!) : supported(c)));

    const jobId = await startJob(sentences(31), 'idem-refund');
    const done = await untilTerminal(jobId);

    expect(done.status).toBe('done');
    expect(done).toMatchObject({ factClaims: 31, checked: 20, failed: 11 });
    expect(done.units).toEqual({ charged: 4, served: 3, refund: 1 });
    expect(done.unserved).toHaveLength(11);
    expect(done.unserved).toEqual([...reasons].map(([claimId, reason]) => ({ claimId, reason })));
    const lost = done.progress.filter((p: Json) => p.status === 'unserved');
    expect(lost).toHaveLength(11);
    expect(lost.every((p: Json) => p.verdict?.apiError === true)).toBe(true);

    const [row] = ledgerRows();
    expect(row.reasons).toEqual({ rate_limited: 6, provider_unavailable: 5 });
    expect(row.verdicts).toEqual({ supported: 20 });
    expect(row.servedClaims).toBe(20);
  });

  it('an unverified verdict from a check that ran is not served: refunded as no_sourced_verdict, not counted as failed', async () => {
    useFixtureProvider(async (c) => ({ claimId: c.id, status: 'unverified', explanation: 'no evidence', sources: [MOCK_SOURCE] }));
    const jobId = await startJob(sentences(8), 'idem-abstain');
    const done = await untilTerminal(jobId);
    expect(done.units).toEqual({ charged: 1, served: 0, refund: 1 });
    expect(done.checked).toBe(0);
    expect(done.failed).toBe(0);
    expect(done.unserved).toHaveLength(8);
    expect(done.unserved.every((u: Json) => u.reason === 'no_sourced_verdict')).toBe(true);
    expect(ledgerRows()[0].reasons).toEqual({ no_sourced_verdict: 8 });
  });

  it('the real mock cites no source, so a job on it serves nothing and refunds every unit', async () => {
    control.rawMock = true;
    const jobId = await startJob(sentences(9), 'idem-raw-mock');
    const done = await untilTerminal(jobId);
    expect(done.factClaims).toBe(9);
    expect(done.units).toEqual({ charged: 2, served: 0, refund: 2 });
    expect(done.unserved).toHaveLength(9);
    expect(done.progress.every((p: Json) => p.status === 'unserved' && p.verdict?.status === 'supported')).toBe(true);
  });

  it('under the mock id a sourced verdict serves nothing: mock has no engine retriever', async () => {
    const est = await estimate(sentences(9), {}, { provider: 'mock' });
    expect(est.statusCode).toBe(200);
    const started = await start(est.json.estimateId, 'idem-mock-id');
    expect(started.statusCode).toBe(202);
    const done = await untilTerminal(started.json.jobId);
    expect(done.factClaims).toBe(9);
    expect(done.progress).toHaveLength(9);
    // Each verdict is supported with a source, yet none is served.
    expect(done.progress.every((p: Json) => p.status === 'unserved' && p.verdict?.status === 'supported'
      && p.verdict?.sources?.length === 1 && p.verdict?.provenance?.retriever === undefined)).toBe(true);
    expect(done.units).toEqual({ charged: 2, served: 0, refund: 2 });
    expect(done.unserved.every((u: Json) => u.reason === 'no_sourced_verdict')).toBe(true);
  });

  it('under the engine id the same verdicts are served, with the engine retriever', async () => {
    const jobId = await startJob(sentences(9), 'idem-engine-id');
    const done = await untilTerminal(jobId);
    expect(done.progress).toHaveLength(9);
    expect(done.progress.every((p: Json) => p.status === 'served' && p.verdict?.provenance?.retriever === 'gemini-grounding')).toBe(true);
    expect(done.units).toEqual({ charged: 2, served: 2, refund: 0 });
  });

  it('a provider that throws on every retry is unserved with the engine reason (real retry ladder)', async () => {
    const verifyClaim = useFixtureProvider(async (c) => {
      if (c.id === 'c2') throw new Error('429 Too Many Requests');
      return supported(c);
    });
    const jobId = await startJob(sentences(3), 'idem-throw');
    const done = await untilTerminal(jobId, {}, 12_000);

    expect(verifyClaim.mock.calls.filter(([c]) => c.id === 'c2')).toHaveLength(3);
    expect(done.status).toBe('done');
    expect(done.unserved).toEqual([{ claimId: 'c2', reason: 'rate_limited' }]);
    expect(done.units).toEqual({ charged: 1, served: 1, refund: 0 });
  }, 15_000);

  it('a run that throws outright is failed: served 0, every unit refunded, no result', async () => {
    const est = await estimate(sentences(9));
    control.failGetProvider = true;
    const started = await start(est.json.estimateId, 'idem-failed');
    const failed = await untilTerminal(started.json.jobId);

    expect(failed.status).toBe('failed');
    expect(failed.units).toEqual({ charged: 2, served: 0, refund: 2 });
    expect(failed.unserved).toHaveLength(9);
    expect(failed.unserved.every((u: Json) => u.reason === 'not_attempted')).toBe(true);
    expect(failed.result).toBeUndefined();
    expect(failed.resultAvailable).toBe(false);
    expect(ledgerRows()[0]).toMatchObject({ status: 'failed', servedClaims: 0, units: { charged: 2, served: 0, refund: 2 } });
    // Counted when the job was admitted; a later failure does not undo the count.
    expect(getUsageMeter().getMonthlyCount('admin')).toBe(1);
  });

  it('a run that fails after a sourced verdict landed served nothing, yet stays counted from admission', async () => {
    useFixtureProvider(async (c) => supported(c));
    const store = getFullScanJobStore();
    const record = store.recordVerdict.bind(store);
    let recorded = 0;
    vi.spyOn(store, 'recordVerdict').mockImplementation((job, index, verdict) => {
      record(job, index, verdict);
      recorded += 1;
      if (recorded === 1) throw new Error('the run broke after its first verdict');
    });
    const jobId = await startJob(sentences(3), 'idem-failed-late');
    const failed = await untilTerminal(jobId);

    const found = store.lookup(jobId, 'admin');
    expect(found.kind).toBe('job');
    const verdicts = found.kind === 'job' ? found.job.verdicts : [];
    expect(verdicts.filter((v) => v?.status === 'supported' && v.sources.length > 0).length).toBeGreaterThan(0);
    expect(failed.status).toBe('failed');
    expect(failed.checked).toBe(0);
    expect(failed.resultAvailable).toBe(false);
    expect(failed.units).toEqual({ charged: 1, served: 0, refund: 1 });
    expect(getUsageMeter().getMonthlyCount('admin')).toBe(1);
    // The provider spend is still recorded for the failed run.
    expect(getCostStore().getManagedEvents().filter((e) => e.kind === 'full-scan')).toHaveLength(2);
  });
});

describe('POST /scan/full answers', () => {
  it('400 idempotency_key_required without the header; 400 idempotency_key_invalid for a malformed one', async () => {
    const est = await estimate(sentences(2));
    expect((await start(est.json.estimateId, undefined)).json).toEqual({ error: 'idempotency_key_required' });
    expect((await start(est.json.estimateId, undefined)).statusCode).toBe(400);
    const bad = await start(est.json.estimateId, 'has a space');
    expect(bad.statusCode).toBe(400);
    expect(bad.json).toEqual({ error: 'idempotency_key_invalid' });
    // Only fw's plain-token form reaches the ledger: no URL, no free text, no 1-char key (codex F12-2).
    for (const key of ['https://sensitive.invalid/private-user-content', 'a.b.c.d.e.f', 'short', 'x'.repeat(129)]) {
      const res = await start(est.json.estimateId, key);
      expect(res.statusCode).toBe(400);
      expect(res.json).toEqual({ error: 'idempotency_key_invalid' });
    }
    expect((await start(est.json.estimateId, 'Ab0_-xyz')).statusCode).toBe(202);
  });

  it('410 estimate_expired for an unknown id, a 30-minute-old estimate, and another key\'s estimate', async () => {
    const unknown = await start('fse_00000000000000000000000000000000', 'idem-unknown');
    expect(unknown.statusCode).toBe(410);
    expect(unknown.json).toEqual({ error: 'estimate_expired' });

    const old = await estimate(sentences(2));
    getFullScanJobStore().getEstimate(old.json.estimateId)!.expiresAt = Date.now() - 1;
    expect((await start(old.json.estimateId, 'idem-old')).json).toEqual({ error: 'estimate_expired' });

    const other = getKeyStore().create('other-key');
    const theirs = await estimate(sentences(2), { key: other.key });
    expect(theirs.statusCode).toBe(200);
    const stolen = await start(theirs.json.estimateId, 'idem-stolen');
    expect(stolen.statusCode).toBe(410);
    expect(stolen.json).toEqual({ error: 'estimate_expired' });
  });

  it('a replayed Idempotency-Key returns the same job and never runs it twice', async () => {
    const verifyClaim = useFixtureProvider(async (c) => supported(c));
    const est = await estimate(sentences(5));
    const first = await start(est.json.estimateId, 'idem-replay');
    const second = await start(est.json.estimateId, 'idem-replay');
    expect(second.statusCode).toBe(202);
    expect(second.json).toEqual(first.json);
    await untilTerminal(first.json.jobId);
    const third = await start(est.json.estimateId, 'idem-replay');
    expect(third.json).toEqual(first.json);

    expect(verifyClaim).toHaveBeenCalledTimes(5);
    expect(getUsageMeter().getMonthlyCount('admin')).toBe(1);
    expect(ledgerRows()).toHaveLength(1);
  });

  it('409 idempotency_conflict when the same key names a different estimate', async () => {
    const jobId = await startJob(sentences(2), 'idem-conflict');
    await untilTerminal(jobId);
    const other = await estimate(sentences(3));
    const res = await start(other.json.estimateId, 'idem-conflict');
    expect(res.statusCode).toBe(409);
    expect(res.json).toEqual({ error: 'idempotency_conflict' });
  });

  it('409 estimate_used when an estimate already started under another Idempotency-Key', async () => {
    const est = await estimate(sentences(2));
    expect((await start(est.json.estimateId, 'idem-first')).statusCode).toBe(202);
    const res = await start(est.json.estimateId, 'idem-second');
    expect(res.statusCode).toBe(409);
    expect(res.json).toEqual({ error: 'estimate_used' });
  });

  it('409 job_running while the user has a job, and a new job starts once it ends', async () => {
    const gate = gated();
    const jobId = await startJob(sentences(4), 'idem-run-1', { userRef: USER_A });
    const second = await estimate(sentences(2), { userRef: USER_A });
    const blocked = await start(second.json.estimateId, 'idem-run-2', { userRef: USER_A });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json).toEqual({ error: 'job_running' });

    await gate.releaseAll();
    await untilTerminal(jobId);
    const retry = await start(second.json.estimateId, 'idem-run-2', { userRef: USER_A });
    expect(retry.statusCode).toBe(202);
  });

  it('forged body fields cannot set units, mode, cap or concurrency', async () => {
    const gate = gated();
    const est = await estimate(sentences(10), {}, { mode: 'quick', verifyCap: 1, concurrency: 100, units: 99 });
    expect(est.statusCode).toBe(200);
    expect(est.json).toMatchObject({ factClaims: 10, units: 2 });

    const started = await start(est.json.estimateId, 'idem-forged', {}, { units: 0, mode: 'quick', concurrency: 50, verifyCap: 1 });
    expect(started.statusCode).toBe(202);
    expect(started.json.units).toBe(2);
    await gate.release(0);
    expect(gate.inFlight()).toBe(4);

    await gate.releaseAll();
    const done = await untilTerminal(started.json.jobId);
    expect(gate.verifyClaim).toHaveBeenCalledTimes(10);
    expect(gate.maxInFlight()).toBe(4);
    expect(done.units).toEqual({ charged: 2, served: 2, refund: 0 });
  });
});

describe('monthly scan quota admission', () => {
  const capOne = () => {
    process.env.FAULTLINE_USAGE_CAP = 'on';
    process.env.FAULTLINE_CAP_FREE = '1';
    const entry = getKeyStore().create('capped-key');
    return { key: entry.key, id: entry.id };
  };

  it('a job is counted when it is admitted, so its slot is taken while it runs: a second job and a /scan are 402', async () => {
    const gate = gated();
    const { key, id } = capOne();
    const first = await estimate(sentences(2), { key });
    const second = await estimate(sentences(2), { key });
    const started = await start(first.json.estimateId, 'idem-cap-inflight', { key });
    expect(started.statusCode).toBe(202);
    await waitFor(async () => gate.inFlight() > 0);
    expect((await poll(started.json.jobId, { key })).json.status).toBe('running');
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
    const callsBefore = gate.verifyClaim.mock.calls.length;

    const refusedJob = await start(second.json.estimateId, 'idem-cap-inflight-2', { key });
    expect(refusedJob.statusCode).toBe(402);
    const refusedScan = await call('POST', '/scan', { key }, { text: sentences(1), provider: 'mock' });
    expect(refusedScan.statusCode).toBe(402);
    expect(gate.verifyClaim).toHaveBeenCalledTimes(callsBefore);

    await gate.releaseAll();
    expect((await untilTerminal(started.json.jobId, { key })).status).toBe('done');
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
  });

  it('a new job from a key at its cap is 402 before it is queued; nothing runs or is counted', async () => {
    const verifyClaim = useFixtureProvider(async (c) => supported(c));
    const { key, id } = capOne();
    const first = await estimate(sentences(2), { key });
    const second = await estimate(sentences(2), { key });
    const started = await start(first.json.estimateId, 'idem-cap-1', { key });
    expect(started.statusCode).toBe(202);
    await untilTerminal(started.json.jobId, { key });
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
    const callsBefore = verifyClaim.mock.calls.length;

    const refused = await start(second.json.estimateId, 'idem-cap-2', { key });
    expect(refused.statusCode).toBe(402);
    expect(refused.json).toMatchObject({ error: 'Monthly scan quota exceeded.', limit: 1, used: 1, remaining: 0 });
    expect(verifyClaim).toHaveBeenCalledTimes(callsBefore);
    expect(getFullScanJobStore().jobForIdempotencyKey(id, 'idem-cap-2')).toBeUndefined();
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
  });

  it('an idempotent replay of an existing job is not refused at the cap and runs nothing', async () => {
    const verifyClaim = useFixtureProvider(async (c) => supported(c));
    const { key, id } = capOne();
    const est = await estimate(sentences(2), { key });
    const first = await start(est.json.estimateId, 'idem-cap-replay', { key });
    await untilTerminal(first.json.jobId, { key });
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);

    const replay = await start(est.json.estimateId, 'idem-cap-replay', { key });
    expect(replay.statusCode).toBe(202);
    expect(replay.json).toEqual(first.json);
    expect(verifyClaim).toHaveBeenCalledTimes(2);
    expect(getUsageMeter().getMonthlyCount(id)).toBe(1);
  });

  it('an estimate from a key at its cap is 402 with no extraction', async () => {
    const { key, id } = capOne();
    getUsageMeter().increment(id);
    const refused = await estimate(sentences(2), { key });
    expect(refused.statusCode).toBe(402);
    expect(getCostStore().getManagedEvents().filter((e) => e.kind === 'full-scan')).toHaveLength(0);
  });
});

describe('user-ref (x-faultline-user-ref)', () => {
  it('from the server key, two users run at once; one user cannot start a second job', async () => {
    gated();
    await startJob(sentences(2), 'idem-user-a', { userRef: USER_A });
    const b = await estimate(sentences(2), { userRef: USER_B });
    expect((await start(b.json.estimateId, 'idem-user-b', { userRef: USER_B })).statusCode).toBe(202);
    const a2 = await estimate(sentences(2), { userRef: USER_A });
    expect((await start(a2.json.estimateId, 'idem-user-a2', { userRef: USER_A })).json).toEqual({ error: 'job_running' });
  });

  it('an estimate made for one user cannot be started for another', async () => {
    const est = await estimate(sentences(2), { userRef: USER_A });
    const res = await start(est.json.estimateId, 'idem-cross-user', { userRef: USER_B });
    expect(res.statusCode).toBe(410);
    expect(res.json).toEqual({ error: 'estimate_expired' });
  });

  it('from a direct key the header is ignored: the key is one user', async () => {
    gated();
    const direct = getKeyStore().create('direct-key');
    await startJob(sentences(2), 'idem-direct-1', { key: direct.key, userRef: USER_A });
    const second = await estimate(sentences(2), { key: direct.key, userRef: USER_B });
    const res = await start(second.json.estimateId, 'idem-direct-2', { key: direct.key, userRef: USER_B });
    expect(res.statusCode).toBe(409);
    expect(res.json).toEqual({ error: 'job_running' });
  });

  it('a malformed header from the server key is ignored (the key counts as one user)', async () => {
    gated();
    await startJob(sentences(2), 'idem-malformed-1', { userRef: 'short' });
    const second = await estimate(sentences(2), { userRef: 'has spaces in it' });
    expect((await start(second.json.estimateId, 'idem-malformed-2', { userRef: 'has spaces in it' })).json)
      .toEqual({ error: 'job_running' });
  });

  it('estimates are limited per (key, user-ref) per minute', async () => {
    process.env.FAULTLINE_FULL_ESTIMATE_PER_MIN = '2';
    expect((await estimate(sentences(1), { userRef: USER_A })).statusCode).toBe(200);
    expect((await estimate(sentences(1), { userRef: USER_A })).statusCode).toBe(200);
    const third = await estimate(sentences(1), { userRef: USER_A });
    expect(third.statusCode).toBe(429);
    expect(third.json).toMatchObject({ error: 'estimate_rate_limited', limit: 2 });
    expect((await estimate(sentences(1), { userRef: USER_B })).statusCode).toBe(200);
  });
});

describe('process-wide ceiling and stop', () => {
  it('beyond FAULTLINE_FULL_MAX_RUNNING jobs queue FIFO and start when a slot frees', async () => {
    process.env.FAULTLINE_FULL_MAX_RUNNING = '1';
    const gate = gated();
    const first = await startJob(sentences(2), 'idem-ceiling-1', { userRef: USER_A });
    const second = await startJob(sentences(2), 'idem-ceiling-2', { userRef: USER_B });
    await gate.release(0);

    expect((await poll(first)).json.status).toBe('running');
    expect((await poll(second)).json.status).toBe('queued');
    expect(getFullScanJobStore().runningCount()).toBe(1);
    expect(gate.verifyClaim).toHaveBeenCalledTimes(2);

    await gate.release(2);
    expect((await poll(first)).json.status).toBe('done');
    expect((await poll(second)).json.status).toBe('running');
    await gate.releaseAll();
    expect((await untilTerminal(second)).status).toBe('done');
  });

  it('stopping a queued job stops it at once: nothing verified, every unit refunded', async () => {
    process.env.FAULTLINE_FULL_MAX_RUNNING = '1';
    const gate = gated();
    await startJob(sentences(2), 'idem-q-1', { userRef: USER_A });
    const queued = await startJob(sentences(9), 'idem-q-2', { userRef: USER_B });

    const stopped = await stop(queued);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json.status).toBe('stopped');
    expect(stopped.json.units).toEqual({ charged: 2, served: 0, refund: 2 });
    expect(stopped.json.unserved).toHaveLength(9);
    expect(stopped.json.unserved.every((u: Json) => u.reason === 'not_attempted')).toBe(true);

    await gate.releaseAll();
    expect(gate.verifyClaim).toHaveBeenCalledTimes(2);
    const again = await stop(queued);
    expect(again.json).toEqual(stopped.json);
    // Both jobs were admitted, so both count, the stopped queued job too.
    expect(getUsageMeter().getMonthlyCount('admin')).toBe(2);
  });

  it('stopping a running job starts no new claim and stops when in-flight claims finish', async () => {
    const gate = gated();
    const jobId = await startJob(sentences(20), 'idem-stop-running');
    await gate.release(2); // c1, c2 land; c5, c6 start
    expect(gate.inFlight()).toBe(4);

    const stopping = await stop(jobId);
    expect(stopping.json.status).toBe('running');
    await gate.releaseAll();

    const done = await untilTerminal(jobId);
    expect(done.status).toBe('stopped');
    expect(gate.verifyClaim).toHaveBeenCalledTimes(6);
    expect(done.checked).toBe(6);
    expect(done.units).toEqual({ charged: 3, served: 1, refund: 2 });
    expect(done.unserved).toHaveLength(14);
    expect(done.unserved.every((u: Json) => u.reason === 'not_attempted')).toBe(true);
    expect(done.result.notAttemptedClaimIds).toHaveLength(14);
    const unchanged = await stop(jobId);
    expect(unchanged.json).toEqual(done);
    // Counted once, at admission; stopping it changes nothing.
    expect(getUsageMeter().getMonthlyCount('admin')).toBe(1);
  });
});

describe('GET /scan/full/:jobId answers', () => {
  it('404 job_not_found for another key\'s job (GET and stop), and for a garbage id', async () => {
    const jobId = await startJob(sentences(2), 'idem-owner');
    await untilTerminal(jobId);
    const other = getKeyStore().create('other-key');

    const res = await poll(jobId, { key: other.key });
    expect(res.statusCode).toBe(404);
    expect(res.json).toEqual({ error: 'job_not_found' });
    expect((await stop(jobId, { key: other.key })).json).toEqual({ error: 'job_not_found' });
    expect((await poll(jobId)).statusCode).toBe(200);

    const garbage = await poll('not-a-job-id');
    expect(garbage.statusCode).toBe(404);
    expect(garbage.json).toEqual({ error: 'job_not_found' });
  });

  it('410 job_expired for an id issued over 24 h ago; 404 job_lost for a recent id we no longer hold', async () => {
    const expired = await poll(newJobId(Date.now() - 25 * 3_600_000));
    expect(expired.statusCode).toBe(410);
    expect(expired.json).toEqual({ error: 'job_expired' });

    const lost = await poll(newJobId(Date.now() - 60_000));
    expect(lost.statusCode).toBe(404);
    expect(lost.json).toEqual({ error: 'job_lost' });
  });

  it('a running job lost at a restart reads as job_lost', async () => {
    gated();
    const jobId = await startJob(sentences(4), 'idem-lost');
    resetFullScanJobStore();
    const res = await poll(jobId);
    expect(res.statusCode).toBe(404);
    expect(res.json).toEqual({ error: 'job_lost' });
  });
});

describe('persistence', () => {
  const PLANTED = 'Zanzibarquokka7731 marks the planted input';

  // GoPMO 1.18.11.3 P2: a status outside the allowlist is never served as given.
  it('a verdict outside the allowlist is unserved (provider_error) and refunded, never shown', async () => {
    useFixtureProvider(async (c) => (c.id === 'c2' ? { ...supported(c), status: 'ROYALLY_CERTIFIED' as never } : supported(c)));
    const jobId = await startJob(sentences(3), 'idem-allowlist');
    const done = await untilTerminal(jobId);
    expect(JSON.stringify(done)).not.toContain('ROYALLY_CERTIFIED');
    const c2 = done.progress.find((p: Json) => p.claimId === 'c2');
    expect(c2).toMatchObject({ status: 'unserved', reason: 'provider_error' });
    expect(done.unserved).toEqual([{ claimId: 'c2', reason: 'provider_error' }]);
    expect(done.progress.filter((p: Json) => p.status === 'served')).toHaveLength(2);
  });

  it('the job store itself replaces a verdict outside the allowlist (no engine in the loop)', () => {
    const job = { status: 'running', factIds: ['c1'], verdicts: [undefined] } as never as Parameters<ReturnType<typeof getFullScanJobStore>['recordVerdict']>[0];
    getFullScanJobStore().recordVerdict(job, 0, { claimId: 'c1', status: 'ROYALLY_CERTIFIED' as never, explanation: 'x', sources: [] });
    expect(job.verdicts[0]).toMatchObject({ claimId: 'c1', status: 'unverified', apiError: true, apiErrorReason: 'provider_error' });
  });

  // Google's grounding terms: Search Suggestions are shown unaltered with the
  // grounded verdict, and grounded output is never cached (fw al:da4e96a09515f831).
  it('Search Suggestions reach the submitter unaltered and never reach the ledger', async () => {
    const CHIP = '<style>.chip{}</style><div class="chip">Okapiquill4417 suggestion</div>';
    useFixtureProvider(async (c) => ({
      ...supported(c),
      searchEntryPoint: { renderedContent: CHIP },
      webSearchQueries: ['okapiquill4417 query'],
    }));
    const jobId = await startJob(sentences(3), 'idem-chip');
    const live = await untilTerminal(jobId);
    const served = live.progress.filter((p: Json) => p.status === 'served');
    expect(served).toHaveLength(3);
    for (const p of served) {
      expect(p.verdict.searchEntryPoint).toEqual({ renderedContent: CHIP });
      expect(p.verdict.webSearchQueries).toEqual(['okapiquill4417 query']);
    }
    const raw = readFileSync(ledgerFile, 'utf8');
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).not.toContain('Okapiquill4417');
    expect(raw).not.toContain('okapiquill4417');
  });

  it('a terminal job survives a restart without its result, and the ledger holds no user content', async () => {
    useFixtureProvider(async (c) => (c.id === 'c3' ? apiError(c, 'timeout') : supported(c)));
    const text = `${PLANTED} sentence one. ${sentences(9)}`;
    const jobId = await startJob(text, 'idem-persist', { userRef: USER_A });
    const live = await untilTerminal(jobId);
    expect(live.resultAvailable).toBe(true);
    expect(live.durable).toBe(true);
    expect(JSON.stringify(live.result)).toContain('Zanzibarquokka7731');

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(LEDGER_FIELDS);
    const raw = readFileSync(ledgerFile, 'utf8');
    expect(raw).not.toContain('Zanzibarquokka7731');
    expect(raw).not.toContain(USER_A);
    expect(raw).not.toContain('Sentence');
    expect(rows[0]).toMatchObject({ jobId, keyId: 'admin', status: 'done', factClaims: 10, servedClaims: 9 });
    expect(rows[0].unserved).toEqual([{ claimId: 'c3', reason: 'timeout' }]);

    resetFullScanJobStore();
    const reloaded = await poll(jobId);
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json).toEqual({
      jobId,
      status: 'done',
      factClaims: 10,
      checked: 9,
      failed: 1,
      progress: [],
      unserved: [{ claimId: 'c3', reason: 'timeout' }],
      units: live.units,
      resultAvailable: false,
      durable: true,
    });
    expect(JSON.stringify(reloaded.json)).not.toContain('Zanzibarquokka7731');

    const other = getKeyStore().create('other-key');
    expect((await poll(jobId, { key: other.key })).json).toEqual({ error: 'job_not_found' });
    expect((await stop(jobId)).json).toEqual(reloaded.json);
  });

  it('a failed ledger write keeps the accounting, says durable false, retries once and is counted (codex F12-1)', async () => {
    // The disk fails while the job runs (the start guard only sees the disk at start):
    // a regular file where the ledger directory should be, so every append is ENOTDIR.
    const gate = gated();
    const jobId = await startJob(sentences(9), 'idem-enotdir');
    const blocker = join(tmpDir, 'not-a-dir');
    writeFileSync(blocker, '');
    process.env.FAULTLINE_FULL_JOBS_LEDGER = join(blocker, 'full-scan-jobs.jsonl');
    await gate.releaseAll();
    const done = await untilTerminal(jobId);
    expect(done.status).toBe('done');
    expect(done.units).toEqual({ charged: 2, served: 2, refund: 0 });
    expect(done.durable).toBe(false);
    expect(done.resultAvailable).toBe(true);
    expect((await call('GET', '/usage')).json.fullScanRefunds.ledgerWriteFailures).toBe(1);

    // The restart this flag warns about: the job is gone, so fw must settle on the terminal answer above.
    resetFullScanJobStore();
    expect((await poll(jobId)).json).toEqual({ error: 'job_lost' });
  });

  it('refuses a new job with 503 ledger_unavailable when the ledger cannot be written; nothing runs or is metered', async () => {
    const verifyClaim = useFixtureProvider(async (c) => supported(c));
    const est = await estimate(sentences(3));
    const blocker = join(tmpDir, 'not-a-dir-2');
    writeFileSync(blocker, '');
    process.env.FAULTLINE_FULL_JOBS_LEDGER = join(blocker, 'full-scan-jobs.jsonl');
    const meteredBefore = getUsageMeter().getMonthlyCount('admin');
    const res = await start(est.json.estimateId, 'idem-ledger-down');
    expect(res.statusCode).toBe(503);
    expect(res.json).toEqual({ error: 'ledger_unavailable' });
    expect(verifyClaim).not.toHaveBeenCalled();
    expect(getUsageMeter().getMonthlyCount('admin')).toBe(meteredBefore);

    // Disk back: the same estimate starts normally under the same key.
    process.env.FAULTLINE_FULL_JOBS_LEDGER = ledgerFile;
    const ok = await start(est.json.estimateId, 'idem-ledger-down');
    expect(ok.statusCode).toBe(202);
    expect((await untilTerminal(ok.json.jobId)).durable).toBe(true);
  });

  // codex F12-3 / emma-soul al:d65d2e44c95f00d0: /dev/full accepts a zero-byte append
  // but refuses every real write (ENOSPC), like a full disk.
  const DEV_FULL = '/dev/full';
  const haveDevFull = existsSync(DEV_FULL);

  it.skipIf(!haveDevFull)('the first failed write closes admission: job 2 gets 503 on a ledger that refuses real writes (codex /dev/full case)', async () => {
    useFixtureProvider(async (c) => supported(c));
    const gate = gated();
    const first = await startJob(sentences(13), 'idem-devfull-1', { userRef: USER_A });
    process.env.FAULTLINE_FULL_JOBS_LEDGER = DEV_FULL; // the disk fills while job 1 runs
    await gate.releaseAll();
    const done = await untilTerminal(first);
    expect(done.status).toBe('done');
    expect(done.durable).toBe(false);

    const est = await estimate(sentences(13), { userRef: USER_B });
    const second = await start(est.json.estimateId, 'idem-devfull-2', { userRef: USER_B });
    expect(second.statusCode).toBe(503);
    expect(second.json).toEqual({ error: 'ledger_unavailable' });
    const third = await start(est.json.estimateId, 'idem-devfull-3', { userRef: USER_B });
    expect(third.statusCode).toBe(503);
    const refunds = (await call('GET', '/usage')).json.fullScanRefunds;
    expect(refunds).toMatchObject({ ledgerWriteFailures: 1, admissionClosed: true });
  });

  it.skipIf(!haveDevFull)('a ledger that refuses real writes from the start refuses job 1 (the admission write is non-empty)', async () => {
    const verifyClaim = useFixtureProvider(async (c) => supported(c));
    const est = await estimate(sentences(3));
    process.env.FAULTLINE_FULL_JOBS_LEDGER = DEV_FULL;
    const res = await start(est.json.estimateId, 'idem-devfull-first');
    expect(res.statusCode).toBe(503);
    expect(res.json).toEqual({ error: 'ledger_unavailable' });
    expect(verifyClaim).not.toHaveBeenCalled();
  });

  it.skipIf(!haveDevFull)('admission reopens only after a padded probe row reaches the disk; hydrate skips the probe row', async () => {
    useFixtureProvider(async (c) => supported(c));
    const est = await estimate(sentences(2));
    process.env.FAULTLINE_FULL_JOBS_LEDGER = DEV_FULL;
    expect((await start(est.json.estimateId, 'idem-reopen')).statusCode).toBe(503);
    expect(getFullScanJobStore().admissionClosed()).toBe(true);

    process.env.FAULTLINE_FULL_JOBS_LEDGER = ledgerFile; // disk healthy again
    const ok = await start(est.json.estimateId, 'idem-reopen');
    expect(ok.statusCode).toBe(202);
    expect(getFullScanJobStore().admissionClosed()).toBe(false);
    await untilTerminal(ok.json.jobId);
    const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const probe = lines.find((l) => l.includes('"probe":"ledger-writable"'));
    expect(probe).toBeDefined();
    expect(probe!.length).toBeGreaterThanOrEqual(8000);
    resetFullScanJobStore();
    expect((await call('GET', '/usage')).json.fullScanRefunds.jobs).toBe(1); // the probe row is not a job
  });

  it.skipIf(!haveDevFull)('a job still queued when the first write fails finishes unrun: nothing verified, every unit refunded', async () => {
    process.env.FAULTLINE_FULL_MAX_RUNNING = '1';
    const gate = gated();
    const first = await startJob(sentences(2), 'idem-q-1', { userRef: USER_A });
    const queued = await startJob(sentences(9), 'idem-q-2', { userRef: USER_B });
    expect((await poll(queued)).json.status).toBe('queued');
    process.env.FAULTLINE_FULL_JOBS_LEDGER = DEV_FULL;
    await gate.releaseAll();
    await untilTerminal(first);
    const refused = await untilTerminal(queued);
    expect(refused.status).toBe('failed');
    expect(refused.checked).toBe(0);
    expect(refused.units).toEqual({ charged: 2, served: 0, refund: 2 });
    expect(refused.unserved.length).toBeGreaterThan(0);
    expect(refused.unserved.every((u: Json) => u.reason === 'not_attempted')).toBe(true);
  });

  it('nearly full disk (a one-byte write fits, a row does not): the failed row closes admission, job 2 gets 503', async () => {
    useFixtureProvider(async (c) => supported(c));
    const writes: number[] = [];
    setFullScanLedgerAppendForTests((path, data) => {
      writes.push(data.length);
      if (data.length > 1) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      appendFileSync(path, data);
    });
    try {
      const first = await startJob(sentences(13), 'idem-nearfull-1', { userRef: USER_A });
      expect((await untilTerminal(first)).durable).toBe(false);
      const est = await estimate(sentences(13), { userRef: USER_B });
      const second = await start(est.json.estimateId, 'idem-nearfull-2', { userRef: USER_B });
      expect(second.statusCode).toBe(503);
      expect(second.json).toEqual({ error: 'ledger_unavailable' });
      // job 1's admission was a 1-byte write; job 2's was refused on an 8 KB probe row.
      expect(writes[0]).toBe(1);
      expect(writes[writes.length - 1]).toBeGreaterThanOrEqual(8000);
    } finally {
      setFullScanLedgerAppendForTests(null);
    }
  });

  it('a job still running says durable false; a written terminal job says true', async () => {
    const gate = gated();
    const jobId = await startJob(sentences(2), 'idem-durable');
    expect((await poll(jobId)).json.durable).toBe(false);
    await gate.releaseAll();
    expect((await untilTerminal(jobId)).durable).toBe(true);
  });

  it('a replayed start after a restart returns the same terminal job, never a second run', async () => {
    const verifyClaim = useFixtureProvider(async (c) => supported(c));
    const est = await estimate(sentences(9));
    const first = await start(est.json.estimateId, 'idem-restart');
    await untilTerminal(first.json.jobId);
    expect(ledgerRows()[0]).toMatchObject({ idempotencyKey: 'idem-restart', estimateId: est.json.estimateId });

    resetFullScanJobStore();
    const replay = await start(est.json.estimateId, 'idem-restart');
    expect(replay.statusCode).toBe(202);
    expect(replay.json).toEqual({ jobId: first.json.jobId, units: 2, factClaims: 9 });
    expect(verifyClaim).toHaveBeenCalledTimes(9);
    expect(ledgerRows()).toHaveLength(1);
    expect(getUsageMeter().getMonthlyCount('admin')).toBe(1);

    const conflict = await start('fse_11111111111111111111111111111111', 'idem-restart');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json).toEqual({ error: 'idempotency_conflict' });
    expect((await poll(first.json.jobId)).json).toMatchObject({ status: 'done', resultAvailable: false });
  });

  it('a replay of a job that was running at the restart has no record: 410 estimate_expired, GET job_lost', async () => {
    gated();
    const est = await estimate(sentences(4));
    const first = await start(est.json.estimateId, 'idem-running-restart');
    expect(first.statusCode).toBe(202);

    resetFullScanJobStore();
    const replay = await start(est.json.estimateId, 'idem-running-restart');
    expect(replay.statusCode).toBe(410);
    expect(replay.json).toEqual({ error: 'estimate_expired' });
    expect((await poll(first.json.jobId)).json).toEqual({ error: 'job_lost' });
  });

  it('a reloaded row issued over 24 h ago is not replayable', async () => {
    const jobId = newJobId(Date.now() - 25 * 3_600_000);
    const old = { ...row(jobId, 0.5, { charged: 1, served: 1, refund: 0 }), idempotencyKey: 'idem-old-row', estimateId: 'fse_22222222222222222222222222222222' };
    writeFileSync(ledgerFile, JSON.stringify(old) + '\n');
    resetFullScanJobStore();
    const replay = await start(old.estimateId, 'idem-old-row');
    expect(replay.statusCode).toBe(410);
    expect(replay.json).toEqual({ error: 'estimate_expired' });
  });

  it('a reloaded row issued over 24 h ago reads as job_expired', async () => {
    const jobId = newJobId(Date.now() - 25 * 3_600_000);
    writeFileSync(ledgerFile, JSON.stringify(row(jobId, 1, { charged: 1, served: 1, refund: 0 })) + '\n');
    resetFullScanJobStore();
    expect((await poll(jobId)).json).toEqual({ error: 'job_expired' });
  });
});

function row(jobId: string, daysAgo: number, units: FullScanLedgerRow['units'], reasons: FullScanLedgerRow['reasons'] = {}): FullScanLedgerRow {
  return {
    jobId,
    keyId: 'admin',
    status: 'done',
    finishedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    factClaims: units.charged * 8,
    units,
    servedClaims: units.served * 8,
    verdicts: { supported: units.served * 8 },
    reasons,
    unserved: [],
  };
}

describe('GET /usage fullScanRefunds (admin)', () => {
  function writeLedger(rows: FullScanLedgerRow[]): void {
    writeFileSync(ledgerFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    resetFullScanJobStore();
  }

  it('sums the trailing 7 days of the ledger; exactly 10% refunded is not an alert', async () => {
    writeLedger([
      row(newJobId(), 1, { charged: 4, served: 3, refund: 1 }, { rate_limited: 11, provider_out_of_credits: 2 }),
      row(newJobId(), 3, { charged: 6, served: 6, refund: 0 }),
      row(newJobId(), 8, { charged: 10, served: 0, refund: 10 }, { provider_error: 80 }),
    ]);
    const res = await call('GET', '/usage');
    expect(res.statusCode).toBe(200);
    expect(res.json.fullScanRefunds).toEqual({
      days: 7,
      jobs: 2,
      unitsCharged: 10,
      unitsRefunded: 1,
      refundRate: 0.1,
      alert: false,
      reasons: { rate_limited: 11, provider_out_of_credits: 2, provider_unavailable: 0, timeout: 0, provider_error: 0, provider_unparseable: 0, output_truncated: 0, no_sourced_verdict: 0, not_attempted: 0 },
      ledgerWriteFailures: 0,
      admissionClosed: false,
    });
  });

  it('alerts above 10%, and counts a job finished in this process', async () => {
    writeLedger([row(newJobId(), 1, { charged: 4, served: 3, refund: 1 }, { rate_limited: 11 })]);
    process.env.FAULTLINE_FULL_MAX_RUNNING = '1';
    gated();
    await startJob(sentences(2), 'idem-usage-1', { userRef: USER_A });
    const queued = await startJob(sentences(8), 'idem-usage-2', { userRef: USER_B });
    await stop(queued);

    const refunds = (await call('GET', '/usage')).json.fullScanRefunds;
    expect(refunds).toMatchObject({ jobs: 2, unitsCharged: 5, unitsRefunded: 2, alert: true });
    expect(refunds.refundRate).toBeCloseTo(0.4, 6);
    expect(refunds.reasons.not_attempted).toBe(8);
  });

  it('is absent for a non-admin key', async () => {
    const direct = getKeyStore().create('direct-key');
    const res = await call('GET', '/usage', { key: direct.key });
    expect(res.statusCode).toBe(200);
    expect(res.json).not.toHaveProperty('fullScanRefunds');
  });
});
