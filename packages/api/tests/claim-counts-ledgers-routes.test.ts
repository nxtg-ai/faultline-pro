// Validates: claim counts on every scan-cost row and provider-spend row, per route.
/**
 * Each route that records spend writes how many claims the call handled and how
 * many got a billable verdict, on both ledgers: the provider-spend row and the
 * scan-cost row. The stock mock provider prices at $0 and the spend ledger refuses
 * $0 rows, so the registry here returns a fixture provider that reports real usage
 * through the production usage seam on every extract and verify call.
 *
 * The fixture extracts one claim per sentence; a sentence containing "opinion" is an
 * opinion, which is never verified. So a text of 3 facts and 1 opinion extracts 4
 * claims and verifies 3.
 *
 * appendScanCostLog is a no-op under Vitest, so the scan-cost row is built with the
 * same scanCostLogRow it writes, from the event the route recorded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { recordUsage } from '@nxtg/faultline/lib/usage-sink.js';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { getCostStore, resetCostStore, scanCostLogRow } from '../src/store/costs.js';
import { resetFullScanJobStore } from '../src/store/full-scan-jobs.js';
import { resetFullScanEstimateLimiter } from '../src/routes/full-scan.js';

function billedLeg(): void {
  recordUsage({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 200, isGrounding: false });
}

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
    getProvider: vi.fn((_key: string, name?: string) => standIn(name, {
      name: 'Billing Fixture',
      modelId: 'gpt-4o-mini',
      extractClaims: async (text: string): Promise<Claim[]> => {
        billedLeg();
        return text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).map((s, i) => ({
          id: `c${i + 1}`, text: s, type: /opinion/.test(s) ? 'opinion' : 'fact', importance: 3,
        }));
      },
      verifyClaim: async (claim: Claim): Promise<VerificationResult> => {
        billedLeg();
        // One source, so the verdict is billable once the engine binds its
        // retriever (a zero-source verdict never is).
        return { claimId: claim.id, status: 'supported', explanation: 'ok', sources: [{ title: 'S', uri: 'https://example.org/s' }] };
      },
      generateCritiqueAndPrompt: vi.fn(),
    })),
  };
});

/**
 * The provider id each route resolves. A verdict is billable only when the
 * engine bound a retriever to it, and the engine binds one only to the
 * built-in instance of a provider id: 'gemini' gets 'gemini-grounding'. The
 * registry is mocked, so the fixture above answers as that instance and no
 * real Gemini call is made. Under 'mock' no verdict would
 * be billable, because the mock provider has no engine retriever.
 */
const ENGINE_PROVIDER = 'gemini';
const SERVER_KEY = 'claim-counts-server-key';
const TEXT = 'Paris is in France. Water boils at 100 C at sea level. The Moon orbits the Earth. In my opinion jazz is best.';
const EXTRACTED = 4;
const VERIFIED = 3;
const ENV_KEYS = ['GEMINI_API_KEY', 'FAULTLINE_API_KEY', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP', 'FAULTLINE_FULL_JOBS_LEDGER'];

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let spendLedger: string;
let server: FastifyInstance;

function spendRows(): Array<Record<string, unknown>> {
  if (!existsSync(spendLedger)) return [];
  return readFileSync(spendLedger, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function costRows(): Array<Record<string, unknown>> {
  return getCostStore().getManagedEvents(1).map((event) => JSON.parse(scanCostLogRow(event)));
}

const headers = { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' };

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-claim-counts-'));
  spendLedger = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  // Key resolution needs a value for 'gemini'; the mocked registry never uses it.
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = spendLedger;
  process.env.FAULTLINE_FULL_JOBS_LEDGER = join(tmpDir, 'full-scan-jobs.jsonl');
  delete process.env.FAULTLINE_PROVIDER_SPEND_CAP;
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  resetCostStore();
  resetProviderSpendLedger();
  resetFullScanJobStore();
  resetFullScanEstimateLimiter();
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  resetFullScanJobStore();
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetProviderSpendLedger();
});

/** One call wrote one row to each ledger, and both carry the expected counts. */
function expectCountsOnBothLedgers(extracted: number, verified: number): void {
  const spend = spendRows();
  expect(spend.length).toBeGreaterThan(0);
  expect(spend).toHaveLength(1);
  expect((spend[0].costUsd as number)).toBeGreaterThan(0);
  expect(spend[0]).toMatchObject({ claimCount: extracted, verifiedCount: verified });

  const cost = costRows();
  expect(cost.length).toBeGreaterThan(0);
  expect(cost).toHaveLength(1);
  expect(cost[0]).toMatchObject({ scan_id: spend[0].scanId, claim_count: extracted, verified_count: verified });
}

describe('claim counts reach both ledgers', () => {
  it('POST /scan', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan', headers, payload: { text: TEXT, provider: ENGINE_PROVIDER } });
    expect(res.statusCode).toBe(200);
    expect(res.json().claims).toHaveLength(EXTRACTED);
    expectCountsOnBothLedgers(EXTRACTED, VERIFIED);
  });

  it('POST /scan with pipelineConfig', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan', headers, payload: { text: TEXT, provider: ENGINE_PROVIDER, pipelineConfig: { extractionProvider: ENGINE_PROVIDER } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().claims).toHaveLength(EXTRACTED);
    expectCountsOnBothLedgers(EXTRACTED, VERIFIED);
  });

  it('POST /scan/stream', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan/stream', headers, payload: { text: TEXT, provider: ENGINE_PROVIDER } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"complete"');
    expectCountsOnBothLedgers(EXTRACTED, VERIFIED);
  });

  it('GET /scan/stream', async () => {
    const res = await server.inject({ method: 'GET', url: `/scan/stream?provider=${ENGINE_PROVIDER}&text=${encodeURIComponent(TEXT)}`, headers: { 'x-api-key': SERVER_KEY } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"complete"');
    expectCountsOnBothLedgers(EXTRACTED, VERIFIED);
  });

  it('POST /scan/full/estimate counts the claims it extracted and verifies none', async () => {
    const res = await server.inject({ method: 'POST', url: '/scan/full/estimate', headers, payload: { text: TEXT, provider: ENGINE_PROVIDER } });
    expect(res.statusCode).toBe(200);
    expect(res.json().factClaims).toBe(VERIFIED);
    expectCountsOnBothLedgers(EXTRACTED, 0);
  });

  it('a full-scan job counts the claims it verified', async () => {
    const est = await server.inject({ method: 'POST', url: '/scan/full/estimate', headers, payload: { text: TEXT, provider: ENGINE_PROVIDER } });
    expect(est.statusCode).toBe(200);
    const started = await server.inject({ method: 'POST', url: '/scan/full', headers: { ...headers, 'idempotency-key': 'idem-claim-counts' }, payload: { estimateId: est.json().estimateId } });
    expect(started.statusCode).toBe(202);
    const jobId = started.json().jobId as string;
    const deadline = Date.now() + 5_000;
    let status = '';
    while (status !== 'done') {
      if (Date.now() > deadline) throw new Error('job did not finish');
      status = (await server.inject({ method: 'GET', url: `/scan/full/${jobId}`, headers: { 'x-api-key': SERVER_KEY } })).json().status;
      if (status !== 'done') await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const spend = spendRows();
    expect(spend.length).toBeGreaterThan(0);
    expect(spend).toHaveLength(2); // the estimate's extraction, then the job's verify run
    expect(spend[1]).toMatchObject({ claimCount: VERIFIED, verifiedCount: VERIFIED });
    const cost = costRows();
    expect(cost.length).toBeGreaterThan(0);
    expect(cost).toHaveLength(2);
    expect(cost[1]).toMatchObject({ scan_id: spend[1].scanId, kind: 'full-scan', claim_count: VERIFIED, verified_count: VERIFIED });
  });
});
