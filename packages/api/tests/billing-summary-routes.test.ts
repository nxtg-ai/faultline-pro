// Validates: billing rule, every scan or verify result says which claims were billed, which were not, and why
//
// Every result a caller gets from POST /scan, POST /scan/deep, the complete
// event of GET and POST /scan/stream, GET /scan/full/:jobId and POST
// /admin/verify-claims carries `billing`: billedClaims, unbilledClaims and the
// unbilled claims with their reasons (billingSummary). Each test reads it from
// the real HTTP response through inject, so a response schema that stripped it
// would fail here.
//
// The engine runs for real. Every provider it resolves is a fixture answering
// as the engine's own 'gemini' instance (helpers/engine-stand-in.ts), so a
// sourced verdict is billable. The fixture splits text into one fact claim per
// sentence and answers each claim from VERDICTS: c1 a sourced supported verdict
// (billed), c2 unverified, c3 supported with no source (the engine downgrades
// it to unverified with noSourceAbstain), c4 a provider error. No network call
// and no real provider key.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { billableVerdictCount } from '@nxtg/faultline/lib/verdict-guard.js';
import { ENGINE_PROVIDER, ONE_SOURCE, placeholderProviderKey } from './helpers/engine-stand-in.js';
import { buildServer } from '../src/server.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getClaimMeter, resetClaimMeter } from '../src/store/claim-meter.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { getScanCache, resetCache } from '../src/store/cache.js';
import { cacheCaller } from '../src/lib/cache-caller.js';
import { resolveVerifyPolicy } from '../src/plugins/verify-cap.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { getFullScanJobStore, resetFullScanJobStore } from '../src/store/full-scan-jobs.js';
import { resetFullScanEstimateLimiter } from '../src/routes/full-scan.js';
import { resetUrlFetcher, setUrlFetcher } from '../src/lib/url-validator.js';

const VERDICTS: Record<string, Partial<VerificationResult>> = {
  c2: { status: 'unverified' },
  c3: { status: 'supported', sources: [] },
  c4: { status: 'unverified', apiError: true, apiErrorReason: 'rate_limited' },
};

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const { engineStandInRegistry } = await import('./helpers/engine-stand-in.js');
  return engineStandInRegistry(await importOriginal(), () => ({
    name: 'Billing fixture',
    modelId: 'fixture-v1',
    extractClaims: async (text: string): Promise<Claim[]> =>
      text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean)
        .map((s, i) => ({ id: `c${i + 1}`, text: s, type: 'fact' as const, importance: 5 })),
    verifyClaim: async (claim: Claim): Promise<VerificationResult> =>
      ({ claimId: claim.id, status: 'supported', explanation: 'ok', sources: ONE_SOURCE, ...VERDICTS[claim.id] } as VerificationResult),
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }));
});

/**
 * What every route must report for the four-claim mix above. `unbilled` follows
 * the order of the result's verifications, which the engine sets; expectBilling
 * compares it by claim id and, where the caller is given the verifications,
 * checks the order against them.
 */
const EXPECTED_BILLING = {
  billedClaims: 1,
  unbilledClaims: 3,
  unbilled: [
    { claimId: 'c2', reason: 'unverified' },
    { claimId: 'c3', reason: 'no_source' },
    { claimId: 'c4', reason: 'rate_limited' },
  ],
};

type Billing = typeof EXPECTED_BILLING;

const byClaimId = (a: { claimId: string }, b: { claimId: string }): number => a.claimId.localeCompare(b.claimId);

function expectBilling(billing: Billing, verifications?: Record<string, unknown>): void {
  expect(billing).toBeDefined();
  expect(billing.billedClaims).toBe(EXPECTED_BILLING.billedClaims);
  expect(billing.unbilledClaims).toBe(EXPECTED_BILLING.unbilledClaims);
  expect(billing.unbilled.length).toBe(3);
  expect([...billing.unbilled].sort(byClaimId)).toEqual(EXPECTED_BILLING.unbilled);
  if (verifications) {
    expect(Object.keys(verifications).sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(billing.unbilled.map((u) => u.claimId)).toEqual(Object.keys(verifications).filter((id) => id !== 'c1'));
  }
}

const TEXT = 'Claim one is a fact. Claim two is a fact. Claim three is a fact. Claim four is a fact.';

const SERVER_KEY = 'billing-summary-server-key-0123456789';
const ENV_KEYS = [
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'FAULTLINE_API_KEY', 'FAULTLINE_CLAIM_METER', 'FAULTLINE_CLAIM_METER_LEDGER', 'FAULTLINE_KEY_IDEMPOTENCY_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_FULL_JOBS_LEDGER', 'FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_EVIDENCE_FETCH',
];
let saved: Record<string, string | undefined>;
let dir: string;
let app: FastifyInstance;

beforeAll(() => { process.env.FAULTLINE_CUSTOMER_KEYS = 'on'; });
afterAll(() => { delete process.env.FAULTLINE_CUSTOMER_KEYS; });

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'fl-billing-summary-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_CLAIM_METER = '1';
  process.env.GEMINI_API_KEY = placeholderProviderKey();
  process.env.FAULTLINE_CLAIM_METER_LEDGER = join(dir, 'claim-meter.jsonl');
  process.env.FAULTLINE_KEY_IDEMPOTENCY_LEDGER = join(dir, 'key-idempotency.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  process.env.FAULTLINE_FULL_JOBS_LEDGER = join(dir, 'full-scan-jobs.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding.jsonl');
  // The deep scan checks each source URL; answer from here, never the network.
  setUrlFetcher(async () => ({ status: 200, headers: {} }));
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
  await app.close();
  resetUrlFetcher();
  resetFullScanJobStore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetClaimMeter();
  resetKeyStore();
  rmSync(dir, { recursive: true, force: true });
});

/** A metered customer key, as in the claim meter tests. */
function customer(claimCap = 100) {
  return getKeyStore().create('customer', ['scan'], undefined, { claimCap, metered: true });
}

function post(url: string, key: string, payload: object, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: { 'x-api-key': key, 'content-type': 'application/json', ...headers }, payload });
}

/** The parsed `complete` event of an SSE body. */
function completeEvent(body: string): Record<string, unknown> {
  const events = body.split('\n\n').filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
  expect(events.length).toBeGreaterThan(0);
  const complete = events.find((e) => e.type === 'complete');
  expect(complete).toBeDefined();
  return complete as Record<string, unknown>;
}

function claimMeterRows(): Array<Record<string, unknown>> {
  const path = process.env.FAULTLINE_CLAIM_METER_LEDGER as string;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.kind !== 'header');
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('billing on every scan or verify result', () => {
  it('POST /scan: billing lists each unbilled claim with its reason', async () => {
    const key = customer();
    const res = await post('/scan', key.key, { text: TEXT, provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verifications.c3).toMatchObject({ status: 'unverified', noSourceAbstain: true });
    expectBilling(body.billing, body.verifications);
    expect(body.billing.billedClaims).toBe(billableVerdictCount(body.verifications));

  });

  it('POST /scan cache hit: billing is computed on read, after the read guards', async () => {
    process.env.OPENAI_API_KEY = placeholderProviderKey();
    const key = customer();
    const miss = await post('/scan', key.key, { text: TEXT, provider: ENGINE_PROVIDER });
    expect(miss.statusCode).toBe(200);
    // A stored result as an older build wrote it: c3 a supported verdict with no
    // source (the read guard serves it unverified, noSourceAbstain), c4 a sourced
    // verdict with no engine retriever. The cache never stores a provider error.
    const { scanId: _scanId, billing: _billing, ...stored } = miss.json() as Record<string, unknown>;
    const retrieved = { provider: 'consensus', model: 'm', verifiedAt: '2026-10-01T00:00:00.000Z', retriever: 'openai-web-search' };
    const verifications = {
      c1: { claimId: 'c1', status: 'supported', explanation: 'ok', sources: ONE_SOURCE, provenance: retrieved },
      c2: { claimId: 'c2', status: 'unverified', explanation: 'ok', sources: [] },
      c3: { claimId: 'c3', status: 'supported', explanation: 'ok', sources: [], provenance: retrieved },
      c4: { claimId: 'c4', status: 'mixed', explanation: 'ok', sources: ONE_SOURCE },
    };
    const caller = cacheCaller({ keyId: key.id, headers: {} } as never) as string;
    const cap = resolveVerifyPolicy(key.id, undefined).cap;
    expect(getScanCache().set(caller, TEXT, 'openai', { ...stored, verifications } as never, cap)).toBe(true);

    const hit = await post('/scan', key.key, { text: TEXT, provider: 'openai' });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers['x-cache']).toBe('HIT');
    const body = hit.json();
    expect(body.verifications.c3).toMatchObject({ status: 'unverified', noSourceAbstain: true });
    expect(body.billing).toEqual({
      billedClaims: 1,
      unbilledClaims: 3,
      unbilled: [
        { claimId: 'c2', reason: 'unverified' },
        { claimId: 'c3', reason: 'no_source' },
        { claimId: 'c4', reason: 'no_retriever' },
      ],
    });
  });

  it('POST /scan/deep: billing is on the deep scan result', async () => {
    const key = customer();
    const res = await post('/scan/deep', key.key, { text: TEXT, provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expectBilling(body.billing, body.verifications);
  });

  it('GET /scan/stream: the complete event carries billing', async () => {
    const key = customer();
    const res = await app.inject({
      method: 'GET',
      url: `/scan/stream?provider=${ENGINE_PROVIDER}&text=${encodeURIComponent(TEXT)}`,
      headers: { 'x-api-key': key.key },
    });
    expect(res.statusCode).toBe(200);
    expectBilling(completeEvent(res.body).billing as Billing);
  });

  it('POST /scan/stream: the complete event carries billing', async () => {
    const key = customer();
    const res = await post('/scan/stream', key.key, { text: TEXT, provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(200);
    expectBilling(completeEvent(res.body).billing as Billing);
  });

  it('GET /scan/full/:jobId: a finished job with verifications carries billing, matching its checked count', async () => {
    const key = customer();
    const est = await post('/scan/full/estimate', key.key, { text: TEXT, provider: ENGINE_PROVIDER });
    expect(est.statusCode).toBe(200);
    const start = await post('/scan/full', key.key, { estimateId: est.json().estimateId }, { 'idempotency-key': 'idem-billing-0001' });
    expect(start.statusCode).toBe(202);
    const jobId = start.json().jobId as string;
    await until(() => {
      const found = getFullScanJobStore().lookup(jobId, key.id);
      return found.kind === 'job' && found.job.status === 'done';
    }, 'the job to finish');
    const res = await app.inject({ method: 'GET', url: `/scan/full/${jobId}`, headers: { 'x-api-key': key.key } });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.result).toBeDefined();
    expectBilling(view.billing, view.result.verifications);
    expect(view.billing.billedClaims).toBe(view.checked);
  });

  it('POST /admin/verify-claims: billing sits beside the per-claim results and survives the response schema', async () => {
    const res = await post('/admin/verify-claims', SERVER_KEY, {
      provider: ENGINE_PROVIDER,
      claims: ['c1', 'c2', 'c3', 'c4'].map((id) => ({ id, text: `Claim ${id} is a fact.` })),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([
      ['c1', 'supported'], ['c2', 'unverified'], ['c3', 'unverified'], ['c4', 'unverified'],
    ]);
    // Claims are verified and reported in the order given.
    expect(body.billing).toEqual(EXPECTED_BILLING);
  });
});

describe('billing agrees with the claim meter', () => {
  it('for one scan, the claims the meter commits equal billing.billedClaims', async () => {
    const key = customer();
    const res = await post('/scan', key.key, { text: TEXT, provider: ENGINE_PROVIDER });
    expect(res.statusCode).toBe(200);
    const billing = res.json().billing as Billing;
    expect(billing.billedClaims).toBeGreaterThan(0);
    const rows = claimMeterRows();
    expect(rows.length).toBe(billing.billedClaims);
    expect(getClaimMeter().usageFor(key.id).used).toBe(billing.billedClaims);
    // The billed claims are exactly the ones billing does not list as unbilled.
    const unbilledIds = new Set(billing.unbilled.map((u) => u.claimId));
    expect(rows.map((r) => r.claimId).sort()).toEqual(['c1', 'c2', 'c3', 'c4'].filter((id) => !unbilledIds.has(id)));
  });
});
