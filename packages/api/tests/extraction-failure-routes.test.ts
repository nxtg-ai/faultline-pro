/**
 * Every API route that runs claim extraction reports a failed extraction as a
 * failure, never as a scan built on synthetic per-sentence claims.
 *
 * Only the provider registry is mocked: the real engine scan() /
 * extractForFullScan() run, and the fixture provider's extractClaims parses its
 * reply with the real parseExtractedClaims, so a truncated reply throws the
 * same ExtractionError a live provider would (measured 2026-10-13: two 150k-char
 * documents "extracted" 945 and 1,049 synthetic claims after truncation).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim } from '@nxtg/faultline/types.js';
import { ExtractionError, parseExtractedClaims } from '@nxtg/faultline/providers/extraction-error.js';
import { recordUsage } from '@nxtg/faultline/lib/usage-sink.js';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { getCostStore, resetCostStore } from '../src/store/costs.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetCache } from '../src/store/cache.js';
import { getFullScanJobStore, resetFullScanJobStore } from '../src/store/full-scan-jobs.js';
import { resetFullScanEstimateLimiter } from '../src/routes/full-scan.js';

/** Replies cut off mid-JSON, as the model's output was on the 150k-char documents. */
const TRUNCATED_REPLY = '[{"id":"c1","text":"The Eiffel Tower is in Paris.","type":"fact","importance":4},{"id":"c2","text":"It opened in 18';
/** Three sentences: a [] extraction would have become three synthetic claims. */
const TEXT = 'The Eiffel Tower is in Paris. It opened in 1889. It is about 330 metres tall.';
const RAW_PROVIDER_TEXT = 'RESOURCE_EXHAUSTED quota generativelanguage.googleapis.com';

const control = vi.hoisted(() => ({
  extract: (async () => []) as (text: string) => Promise<unknown[]>,
  verifyClaim: null as null | ((claim: unknown) => Promise<unknown>),
  /** Provider names the engine asked the registry for, in order. */
  providersTried: [] as string[],
}));

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  return {
    ...actual,
    getProvider: vi.fn((_apiKey: string, name?: string) => (control.providersTried.push(name ?? 'default'), {
      name: 'Extraction Failure Fixture',
      modelId: 'fixture-v1',
      extractClaims: (text: string) => control.extract(text),
      verifyClaim: (claim: unknown) => control.verifyClaim!(claim),
      generateCritiqueAndPrompt: vi.fn(),
    })),
  };
});

const SERVER_KEY = 'test-extraction-failure-server-key';
const ENV_KEYS = [
  'FAULTLINE_API_KEY', 'FAULTLINE_FULL_JOBS_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_FULL_ESTIMATE_PER_MIN', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY',
];

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let server: FastifyInstance;
let verifyClaim: ReturnType<typeof vi.fn>;

/** The model spends tokens, then its reply is cut off mid-JSON. */
function truncatedExtraction(): ReturnType<typeof vi.fn> {
  const extract = vi.fn(async () => {
    recordUsage({ provider: 'gemini', model: 'fixture-v1', callType: 'extraction', inputTokens: 37_500, outputTokens: 65_536, isGrounding: false });
    return parseExtractedClaims(TRUNCATED_REPLY);
  });
  control.extract = extract;
  return extract;
}

function rateLimitedExtraction(): ReturnType<typeof vi.fn> {
  const extract = vi.fn(async (): Promise<unknown[]> => { throw ExtractionError.fromProviderError(new Error(`429 ${RAW_PROVIDER_TEXT}`)); });
  control.extract = extract;
  return extract;
}

function post(url: string, body: Record<string, unknown>) {
  return server.inject({
    method: 'POST', url, headers: { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' }, payload: JSON.stringify(body),
  });
}

/** Parse an SSE body into its events. */
function sseEvents(body: string): Array<Record<string, unknown>> {
  return body.split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => JSON.parse(chunk.slice(6)));
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'extraction-failure-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_FULL_JOBS_LEDGER = join(tmpDir, 'full-scan-jobs.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  delete process.env.FAULTLINE_PROVIDER_SPEND_CAP;
  delete process.env.FAULTLINE_FULL_ESTIMATE_PER_MIN;
  // Fake keys so resolveApiKey passes for every chain provider; the registry is mocked, nothing is called.
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY']) process.env[k] = 'fixture-key';
  verifyClaim = vi.fn(async (claim: Claim) => ({ claimId: claim.id, status: 'supported', explanation: 'ok', sources: [] }));
  control.verifyClaim = verifyClaim as unknown as (claim: unknown) => Promise<unknown>;
  control.providersTried = [];
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCostStore();
  resetProviderSpendLedger();
  resetCircuitBreaker();
  resetCache();
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
  vi.restoreAllMocks();
});

describe('POST /scan', () => {
  it('provider failover: every provider fails extraction → 502 extraction_failed with reason, nothing verified', async () => {
    const extract = truncatedExtraction();
    const res = await post('/scan', { text: TEXT, provider: 'gemini' });

    expect(extract).toHaveBeenCalledTimes(4); // every real provider was tried; mock is never a fallback
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: 'extraction_failed', reason: 'invalid_output' });
    expect(verifyClaim).not.toHaveBeenCalled();
  });

  it('never fails over into the mock provider (whose verdicts are all "supported")', async () => {
    rateLimitedExtraction();
    const res = await post('/scan', { text: TEXT, provider: 'gemini' });

    expect(res.statusCode).toBe(502);
    expect(control.providersTried).toEqual(['gemini', 'openai', 'claude', 'perplexity']);
    expect(control.providersTried).not.toContain('mock');
    expect(JSON.parse(res.body).provider).toBeUndefined();
  });

  it('pipelineConfig branch: extraction failure → 502 extraction_failed without provider text', async () => {
    const extract = rateLimitedExtraction();
    const res = await post('/scan', {
      text: TEXT, pipelineConfig: { extractionProvider: 'gemini', verificationProvider: 'gemini' },
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: 'extraction_failed', reason: 'rate_limited' });
    expect(res.body).not.toContain('RESOURCE_EXHAUSTED');
    expect(extract).toHaveBeenCalledTimes(1); // explicit providers: no failover chain
    expect(verifyClaim).not.toHaveBeenCalled();
  });

  it('control: a valid extraction still scans (200, claims verified)', async () => {
    control.extract = async () => parseExtractedClaims(JSON.stringify([
      { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 4 },
      { id: 'c2', text: 'It opened in 1889.', type: 'fact', importance: 4 },
      { id: 'c3', text: 'It is about 330 metres tall.', type: 'fact', importance: 4 },
    ]));
    const res = await post('/scan', { text: TEXT, provider: 'gemini' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.claims.length).toBe(3);
    expect(verifyClaim).toHaveBeenCalledTimes(3);
  });
});

describe('/scan/stream', () => {
  it('POST: the client gets a start then an extraction_failed error event, never claim_verified or complete', async () => {
    truncatedExtraction();
    const res = await post('/scan/stream', { text: TEXT, provider: 'gemini' });

    expect(res.statusCode).toBe(200);
    const events = sseEvents(res.body);
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ type: 'start', claimCount: 0 });
    expect(events[1]).toMatchObject({ type: 'error', error: 'extraction_failed', reason: 'invalid_output' });
    expect(String(events[1].message)).toContain('nothing was verified');
    expect(events.some((e) => e.type === 'claim_verified' || e.type === 'complete')).toBe(false);
    expect(verifyClaim).not.toHaveBeenCalled();
  });

  it('GET: same error event, no raw provider text', async () => {
    rateLimitedExtraction();
    const res = await server.inject({
      method: 'GET', url: `/scan/stream?text=${encodeURIComponent(TEXT)}&provider=gemini`, headers: { 'x-api-key': SERVER_KEY },
    });

    const events = sseEvents(res.body);
    expect(events.length).toBe(2);
    expect(events[1]).toMatchObject({ type: 'error', error: 'extraction_failed', reason: 'rate_limited' });
    expect(res.body).not.toContain('RESOURCE_EXHAUSTED');
    expect(events.some((e) => e.type === 'complete')).toBe(false);
  });

  it('a non-extraction failure keeps the generic error event (no extraction fields)', async () => {
    control.extract = async () => { throw new TypeError('engine bug'); };
    const res = await post('/scan/stream', { text: TEXT, provider: 'gemini' });

    const events = sseEvents(res.body);
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error).not.toHaveProperty('reason');
    expect(error).not.toHaveProperty('error');
  });
});

describe('POST /scan/full/estimate', () => {
  it('502 extraction_failed with reason; no estimate stored; the spent extraction is still cost-logged', async () => {
    truncatedExtraction();
    const createEstimate = vi.spyOn(getFullScanJobStore(), 'createEstimate');

    const res = await post('/scan/full/estimate', { text: TEXT, provider: 'gemini' });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: 'extraction_failed', reason: 'invalid_output' });
    expect(createEstimate).not.toHaveBeenCalled();
    const events = getCostStore().getManagedEvents().filter((e) => e.kind === 'full-scan');
    expect(events.length).toBe(1);
    expect(events[0].inputTokens).toBe(37_500);
    expect(events[0].outputTokens).toBe(65_536);
  });
});

describe('POST /scan/batch', () => {
  it('a text whose extraction failed on every provider is a failed item carrying its reason, not a result', async () => {
    rateLimitedExtraction();
    const res = await post('/scan/batch', { texts: [TEXT], provider: 'gemini' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.succeeded).toBe(0);
    expect(body.errors.length).toBe(1);
    expect(body.errors[0]).toMatchObject({ index: 0, reason: 'rate_limited' });
    expect(body.errors[0].error).toMatch(/^Claim extraction failed/);
    expect(res.body).not.toContain('RESOURCE_EXHAUSTED');
    expect(verifyClaim).not.toHaveBeenCalled();
  });
});
