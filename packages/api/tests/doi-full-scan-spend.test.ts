// Validates: N-237 (a DOI-settled citation in a full scan records no phantom spend)
/**
 * A full-scan job whose only claim is settled by the DOI registry made no model
 * and no search call, so with zero usage legs its cost row must read $0: no
 * grounding call and no token estimate (independent review, P2). The registry
 * is mocked so the fixture answers as the built-in 'gemini' instance, whose
 * estimate would otherwise be priced; the DOI lookup runs through the real
 * guarded fetch with a stubbed network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { getCostStore, resetCostStore } from '../src/store/costs.js';
import { resetFullScanJobStore } from '../src/store/full-scan-jobs.js';
import { resetFullScanEstimateLimiter } from '../src/routes/full-scan.js';
import { setOutboundFetch, resetOutboundFetch, setOutboundResolver, resetOutboundResolver } from '../src/lib/outbound-url.js';
import { resetDefaultDoiCheck } from '@nxtg/faultline/evidence/doi.js';

const FAKE_DOI = '10.4471/jca.2021.0388';
const verifyClaim = vi.fn(async (claim: Claim): Promise<VerificationResult> => (
  { claimId: claim.id, status: 'supported', explanation: 'searched', sources: [{ title: 'S', uri: 'https://example.org/s' }] }
));

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  const standIns = new WeakMap<object, string>();
  const standIn = <T,>(name: string | undefined, p: T): T => {
    if (name !== undefined && actual.isBuiltInProviderName(name) && p && typeof p === 'object') standIns.set(p, name);
    return p;
  };
  return {
    ...actual,
    builtInProviderIdOf: vi.fn((p: unknown) => (p && typeof p === 'object' ? standIns.get(p) : undefined) ?? actual.builtInProviderIdOf(p)),
    getProvider: vi.fn((_key: string, name?: string) => standIn(name, {
      name: 'DOI fixture',
      modelId: 'gemini-2.5-flash',
      // No usage is recorded: the job's run below must have zero usage legs.
      extractClaims: async (): Promise<Claim[]> => [{
        id: 'c1', text: 'The work exists as cited.', type: 'fact', importance: 3,
        citation: { title: 'Synthetic benchmarks for imaginary tasks', authors: 'Roe, J.', year: '2021', doi: FAKE_DOI },
      }],
      verifyClaim,
      generateCritiqueAndPrompt: vi.fn(),
    })),
  };
});

const SERVER_KEY = 'doi-full-scan-server-key';
const TEXT = `Roe, J. (2021). Synthetic benchmarks for imaginary tasks. https://doi.org/${FAKE_DOI}`;
const ENV_KEYS = ['GEMINI_API_KEY', 'FAULTLINE_API_KEY', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_FULL_JOBS_LEDGER', 'FAULTLINE_DOI_CHECK', 'FAULTLINE_OUTBOUND_ALLOW_PRIVATE'];
const headers = { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' };
const outbound: string[] = [];

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let server: FastifyInstance;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-doi-full-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_FULL_JOBS_LEDGER = join(tmpDir, 'full-scan-jobs.jsonl');
  delete process.env.FAULTLINE_PROVIDER_SPEND_CAP;
  // The suite turns the DOI check and the private-address guard off; this file needs both on.
  delete process.env.FAULTLINE_DOI_CHECK;
  delete process.env.FAULTLINE_OUTBOUND_ALLOW_PRIVATE;
  outbound.length = 0;
  verifyClaim.mockClear();
  setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  setOutboundFetch(async (url) => {
    outbound.push(url);
    return new Response(JSON.stringify({ responseCode: 100, handle: FAKE_DOI }), { status: 404, headers: { 'content-type': 'application/json' } });
  });
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
  resetOutboundFetch();
  resetOutboundResolver();
  resetDefaultDoiCheck();
  resetProviderSpendLedger();
});

describe('full scan: a DOI-settled claim costs nothing', () => {
  it('records $0, no grounding call and no token estimate for a job whose one claim the DOI registry settled', async () => {
    const est = await server.inject({ method: 'POST', url: '/scan/full/estimate', headers, payload: { text: TEXT, provider: 'gemini' } });
    expect(est.statusCode).toBe(200);
    const started = await server.inject({ method: 'POST', url: '/scan/full', headers: { ...headers, 'idempotency-key': 'idem-doi-spend' }, payload: { estimateId: est.json().estimateId } });
    expect(started.statusCode).toBe(202);
    const jobId = started.json().jobId as string;
    const deadline = Date.now() + 5_000;
    let body: Record<string, any> = {};
    while (body.status !== 'done') {
      if (Date.now() > deadline) throw new Error('job did not finish');
      body = (await server.inject({ method: 'GET', url: `/scan/full/${jobId}`, headers: { 'x-api-key': SERVER_KEY } })).json();
      if (body.status !== 'done') await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(outbound).toEqual([`https://doi.org/api/handles/${FAKE_DOI}`]);
    expect(verifyClaim).not.toHaveBeenCalled();
    const verdicts = (body.progress as Array<{ verdict?: VerificationResult }>).map((p) => p.verdict).filter(Boolean);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.provenance?.retriever).toBe('doi-resolver');

    const events = getCostStore().getManagedEvents(1).filter((e) => e.kind === 'full-scan');
    expect(events.length).toBeGreaterThan(0);
    const job = events[events.length - 1]!;
    expect(job.claimsVerified).toBe(1);
    expect(job.groundingCalls).toBe(0);
    expect(job.inputTokens).toBe(0);
    expect(job.costUsd).toBe(0);
  });
});
