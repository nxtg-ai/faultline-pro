// NEXUS: GoPMO 1.18.11.7.22 grounding provider
/**
 * FAULTLINE_GROUNDING=parallel on the hosted paths (docs/grounding-providers.md).
 *
 * Real path: route → scan engine → verify runner → Parallel retriever and
 * geminiService, with only the Gemini SDK mocked at the module boundary and
 * global fetch stubbed for Parallel's endpoint. Every Gemini request's config
 * is recorded, so "no Google search" is read off what was actually sent: no
 * request may carry the googleSearch tool.
 *
 * Under parallel every hosted path (customer keys, the server key faultline-web
 * uses, /scan, /scan/stream, /scan/deep, /batch, the hosted /mcp route) runs
 * Parallel then Gemini with no search tool. Unset, every path keeps Google
 * grounding. A Parallel failure is a not-checked claim, never a Google search.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sdk = vi.hoisted(() => ({ configs: [] as Array<Record<string, any> | undefined>, prompts: [] as string[] }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { contents?: unknown; config?: Record<string, any> }) => {
        sdk.configs.push(params.config);
        const prompt = String(params.contents ?? '');
        sdk.prompts.push(prompt);
        const grounded = (params.config?.tools ?? []).some((t: Record<string, unknown>) => 'googleSearch' in t);
        if (grounded) {
          return {
            text: '{"status":"supported","explanation":"Google grounded."}',
            modelVersion: 'gemini-2.5-flash',
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
            candidates: [{ finishReason: 'STOP', groundingMetadata: { groundingChunks: [{ web: { title: 'G', uri: 'https://google-grounded.example/page' } }] } }],
          };
        }
        if (prompt.includes('Retrieved sources')) {
          return {
            text: '{"status":"supported","explanation":"Judged against the supplied excerpts."}',
            usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20 },
            candidates: [{ finishReason: 'STOP' }],
          };
        }
        return {
          text: JSON.stringify([
            { id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 4 },
            { id: 'c2', text: 'Mount Everest is the highest mountain above sea level.', type: 'fact', importance: 4 },
          ]),
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 40 },
          candidates: [{ finishReason: 'STOP' }],
        };
      },
    };
  },
}));

import { buildServer } from '../src/server.js';
import { isGroundedVerification } from '../src/store/cache.js';
import { resetCache } from '../src/store/cache.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { requestGrounding, groundingOption } from '../src/lib/grounding.js';
import { resetFullScanJobStore } from '../src/store/full-scan-jobs.js';

const SERVER_KEY = 'grounding-parallel-server-key-0123456789';
const TEXT = 'The Eiffel Tower was completed in 1889. Mount Everest is the highest mountain above sea level.';
const PARALLEL_URL = 'https://api.parallel.ai/v1/search';
const ENV_KEYS = [
  'FAULTLINE_API_KEY', 'FAULTLINE_GROUNDING', 'FAULTLINE_PARALLEL_MODE', 'PARALLEL_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY',
  'FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_CONSENSUS', 'FAULTLINE_HISTORY_DIR',
  'FAULTLINE_FULL_JOBS_LEDGER',
];
let saved: Record<string, string | undefined>;
let dir: string;

/** What Parallel answers: 'ok' (two results with excerpts), or an HTTP status to fail with. */
let parallelReply: 'ok' | number = 'ok';
const parallelBodies: Array<Record<string, any>> = [];
const parallelHeaders: Array<Record<string, string>> = [];

const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url !== PARALLEL_URL) return new Response('not stubbed', { status: 404 });
  parallelBodies.push(JSON.parse(String(init?.body)));
  parallelHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
  if (parallelReply !== 'ok') return new Response('{"error":"failure"}', { status: parallelReply, statusText: 'Failure' });
  return new Response(JSON.stringify({
    search_id: 'search_1',
    results: [
      { url: 'https://history.example/eiffel', title: 'Eiffel history', publish_date: '2020-01-02', excerpts: ['Completed in March 1889.', 'Opened for the World Fair.'] },
      { url: 'https://geo.example/everest', title: 'Everest', publish_date: null, excerpts: ['8,849 m above sea level.'] },
    ],
    usage: [{ name: 'sku_search', count: 1 }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
});

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-grounding-parallel-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.PARALLEL_API_KEY = 'test-parallel';
  delete process.env.OPENAI_API_KEY;
  delete process.env.FAULTLINE_CONSENSUS;
  delete process.env.FAULTLINE_GROUNDING;
  delete process.env.FAULTLINE_PARALLEL_MODE;
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  process.env.FAULTLINE_HISTORY_DIR = join(dir, 'history');
  process.env.FAULTLINE_FULL_JOBS_LEDGER = join(dir, 'full-scan-jobs.jsonl');
  resetFullScanJobStore();
  sdk.configs.length = 0;
  sdk.prompts.length = 0;
  parallelBodies.length = 0;
  parallelHeaders.length = 0;
  parallelReply = 'ok';
  fetchStub.mockClear();
  vi.stubGlobal('fetch', fetchStub);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetCache();
  resetRateLimiter();
  resetCircuitBreaker();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  uninstallGroundingCounter();
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetFullScanJobStore();
  rmSync(dir, { recursive: true, force: true });
});

async function withServer<T>(fn: (server: ReturnType<typeof buildServer>, customerKey: string) => Promise<T>): Promise<T> {
  const server = buildServer();
  await server.ready();
  try {
    return await fn(server, getKeyStore().create('Pro', ['pro', 'scan']).key);
  } finally {
    await server.close();
  }
}

/** Gemini requests that carried the googleSearch tool. */
const googleSearchCalls = (): number =>
  sdk.configs.filter((c) => (c?.tools ?? []).some((t: Record<string, unknown>) => 'googleSearch' in t)).length;
/** Gemini requests that carried any tool at all. */
const toolCalls = (): number => sdk.configs.filter((c) => Array.isArray(c?.tools) && c!.tools.length > 0).length;

function spendRows(): Array<Record<string, any>> {
  const path = process.env.FAULTLINE_PROVIDER_SPEND_LEDGER!;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function groundedLedgerRows(): number {
  const path = process.env.FAULTLINE_GROUNDING_LEDGER!;
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).length;
}

async function postScan(server: ReturnType<typeof buildServer>, key: string) {
  return server.inject({
    method: 'POST',
    url: '/scan',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    payload: { text: TEXT, provider: 'gemini' },
  });
}

/** A Parallel-grounded verdict as a caller receives it. */
function expectParallelVerdict(v: Record<string, any>): void {
  expect(v.apiError).not.toBe(true);
  expect(v.status).toBe('supported');
  expect(v.provenance).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash', retriever: 'parallel-search', retrieverModel: 'parallel-search-advanced' });
  expect(typeof v.provenance.retrievedAt).toBe('string');
  expect(v.sources.length).toBeGreaterThan(0);
  expect(v.sources[0]).toMatchObject({
    uri: 'https://history.example/eiffel', title: 'Eiffel history', publishDate: '2020-01-02',
    excerpts: ['Completed in March 1889.', 'Opened for the World Fair.'],
  });
  for (const k of ['searchEntryPoint', 'webSearchQueries']) expect(k in v, `${k} present`).toBe(false);
  expect(JSON.stringify(v)).not.toContain('google-grounded.example');
}

describe('the per-request mode', () => {
  it('reads FAULTLINE_GROUNDING at call time and never writes it', () => {
    expect(requestGrounding({})).toBe('google');
    expect(requestGrounding({ FAULTLINE_GROUNDING: 'parallel' })).toBe('parallel');
    expect(requestGrounding({ FAULTLINE_GROUNDING: ' Parallel ' })).toBe('parallel');
    expect(requestGrounding({ FAULTLINE_GROUNDING: 'bing' })).toBe('google');
    expect(groundingOption('google')).toEqual({});
    expect(groundingOption('parallel')).toEqual({ grounding: 'parallel' });
    const before = { ...process.env };
    requestGrounding();
    expect(process.env).toEqual(before);
  });
});

describe('FAULTLINE_GROUNDING=parallel: Parallel then Gemini, no googleSearch, on every hosted path', () => {
  beforeEach(() => { process.env.FAULTLINE_GROUNDING = 'parallel'; });

  it('customer-key POST /scan: zero googleSearch calls, one Parallel search per claim, verdicts carry Parallel provenance', async () => {
    await withServer(async (server, key) => {
      const res = await postScan(server, key);
      expect(res.statusCode).toBe(200);
      const verifications = Object.values(res.json().verifications as Record<string, any>);
      expect(verifications.length).toBeGreaterThan(0);
      expect(verifications).toHaveLength(2);
      for (const v of verifications) expectParallelVerdict(v);

      expect(sdk.configs.length).toBeGreaterThan(0);
      expect(googleSearchCalls()).toBe(0);
      expect(toolCalls()).toBe(0);
      expect(parallelBodies).toHaveLength(2);
      // The judge read the excerpts: a no-tool shared-source prompt that names them.
      const judgePrompts = sdk.prompts.filter((p) => p.includes('Retrieved sources'));
      expect(judgePrompts).toHaveLength(2);
      expect(judgePrompts[0]).toContain('Excerpt: Completed in March 1889.');
    });
  }, 30_000);

  it('sends the v1 request: objective, keyword search_queries, advanced mode, the ceiling, the key in x-api-key', async () => {
    await withServer(async (server, key) => {
      expect((await postScan(server, key)).statusCode).toBe(200);
      expect(parallelBodies.length).toBeGreaterThan(0);
      const body = parallelBodies[0];
      expect(Object.keys(body).sort()).toEqual(['advanced_settings', 'max_chars_total', 'mode', 'objective', 'search_queries']);
      expect(body.mode).toBe('advanced');
      expect(body.objective).toMatch(/Check this claim: "The Eiffel Tower was completed in 1889\."/);
      expect(body.search_queries.length).toBeGreaterThan(0);
      expect(body.search_queries[0]).toBe('Eiffel Tower completed 1889');
      expect(body.advanced_settings).toEqual({ max_results: 8, excerpt_settings: { max_chars_per_result: 1500 } });
      expect(parallelHeaders[0]['x-api-key']).toBe('test-parallel');
    });
  }, 30_000);

  it('server-key POST /scan (faultline-web) also runs Parallel: zero googleSearch calls', async () => {
    await withServer(async (server) => {
      const res = await postScan(server, SERVER_KEY);
      expect(res.statusCode).toBe(200);
      const verifications = Object.values(res.json().verifications as Record<string, any>);
      expect(verifications.length).toBeGreaterThan(0);
      for (const v of verifications) expectParallelVerdict(v);
      expect(sdk.configs.length).toBeGreaterThan(0);
      expect(googleSearchCalls()).toBe(0);
      expect(parallelBodies).toHaveLength(2);
    });
  }, 30_000);

  it('GET /scan/stream: every claim_verified verdict is Parallel-grounded, zero googleSearch calls', async () => {
    await withServer(async (server, key) => {
      const res = await server.inject({
        method: 'GET',
        url: `/scan/stream?text=${encodeURIComponent(TEXT)}&provider=gemini`,
        headers: { 'x-api-key': key },
      });
      expect(res.statusCode).toBe(200);
      const events = res.body.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
      const verdicts = events.filter((e) => e.type === 'claim_verified').map((e) => e.verdict);
      expect(verdicts.length).toBeGreaterThan(0);
      for (const v of verdicts) expectParallelVerdict(v);
      expect(googleSearchCalls()).toBe(0);
      expect(parallelBodies.length).toBe(verdicts.length);
    });
  }, 30_000);

  it('POST /scan/deep and POST /scan/batch: zero googleSearch calls', async () => {
    await withServer(async (server, key) => {
      const deep = await server.inject({ method: 'POST', url: '/scan/deep', headers: { 'x-api-key': key, 'content-type': 'application/json' }, payload: { text: TEXT, provider: 'gemini' } });
      expect(deep.statusCode).toBe(200);
      const batch = await server.inject({ method: 'POST', url: '/scan/batch', headers: { 'x-api-key': key, 'content-type': 'application/json' }, payload: { texts: [TEXT], provider: 'gemini' } });
      expect(batch.statusCode).toBe(200);
      expect(sdk.configs.length).toBeGreaterThan(0);
      expect(parallelBodies.length).toBeGreaterThan(0);
      expect(googleSearchCalls()).toBe(0);
    });
  }, 30_000);

  it('a full-scan job (POST /scan/full) verifies on Parallel: zero googleSearch calls, the verify row priced with the searches', async () => {
    await withServer(async (server, key) => {
      const headers = { 'x-api-key': key, 'content-type': 'application/json' };
      const est = await server.inject({ method: 'POST', url: '/scan/full/estimate', headers, payload: { text: TEXT, provider: 'gemini' } });
      expect(est.statusCode).toBe(200);
      const started = await server.inject({ method: 'POST', url: '/scan/full', headers: { ...headers, 'idempotency-key': 'idem-grounding-full' }, payload: { estimateId: est.json().estimateId } });
      expect(started.statusCode).toBe(202);
      const jobId = started.json().jobId as string;
      const deadline = Date.now() + 10_000;
      let job: Record<string, any> = {};
      while (job.status !== 'done') {
        if (Date.now() > deadline) throw new Error('job did not finish');
        job = (await server.inject({ method: 'GET', url: `/scan/full/${jobId}`, headers: { 'x-api-key': key } })).json();
        if (job.status !== 'done') await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(sdk.configs.length).toBeGreaterThan(0);
      expect(parallelBodies.length).toBeGreaterThan(0);
      expect(parallelBodies).toHaveLength(2);
      expect(googleSearchCalls()).toBe(0);
      expect(JSON.stringify(job)).toContain('"retriever":"parallel-search"');
      expect(JSON.stringify(job)).not.toContain('gemini-grounding');
      const rows = spendRows();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.at(-1)!.provider).toContain('parallel-search');
    });
  }, 30_000);

  it('the hosted /mcp route follows the customer path: Parallel searches, zero googleSearch calls', async () => {
    await withServer(async (server, key) => {
      const res = await server.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'x-api-key': key },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_claims', arguments: { text: TEXT, provider: 'gemini' } } }),
      });
      expect(res.statusCode).toBe(200);
      const result = JSON.parse(res.body).result;
      expect(result.isError).not.toBe(true);
      const out = result.structuredContent as { claims: Array<{ verdict: string; evidence_urls: string[] }>; mode: string };
      expect(out.claims.length).toBeGreaterThan(0);
      expect(out.mode).toBe('hosted');
      // Every verdict cites the Parallel results, none a Google grounding link.
      expect(out.claims.every((c) => c.verdict === 'VERIFIED' && c.evidence_urls.includes('https://history.example/eiffel'))).toBe(true);
      expect(sdk.configs.length).toBeGreaterThan(0);
      expect(googleSearchCalls()).toBe(0);
      expect(parallelBodies).toHaveLength(2);
    });
  }, 30_000);

  it.each([[500, 'provider_error'], [429, 'rate_limited'], [503, 'provider_unavailable']] as const)(
    'a Parallel %s is a not-checked claim (%s), never a Google search',
    async (status, reason) => {
      parallelReply = status;
      await withServer(async (server, key) => {
        const res = await postScan(server, key);
        expect(res.statusCode).toBe(200);
        const verifications = Object.values(res.json().verifications as Record<string, any>);
        expect(verifications.length).toBeGreaterThan(0);
        for (const v of verifications) {
          expect(v.status).toBe('unverified');
          expect(v.apiError).toBe(true);
          expect(v.apiErrorReason).toBe(reason);
          expect(v.sources).toEqual([]);
          expect(v.provenance).toBeUndefined();
        }
        expect(res.json().degraded).toBe(true);
        expect(parallelBodies.length).toBeGreaterThan(0);
        expect(googleSearchCalls()).toBe(0);
        // Only extraction reached Gemini: no judge without sources, no search fallback.
        expect(sdk.prompts.filter((p) => p.includes('Retrieved sources'))).toHaveLength(0);
      });
    },
    30_000,
  );

  it('no Parallel key: not checked, never a Google search', async () => {
    delete process.env.PARALLEL_API_KEY;
    await withServer(async (server, key) => {
      const res = await postScan(server, key);
      const verifications = Object.values(res.json().verifications as Record<string, any>);
      expect(verifications.length).toBeGreaterThan(0);
      for (const v of verifications) expect(v).toMatchObject({ status: 'unverified', apiError: true, apiErrorReason: 'provider_error' });
      expect(parallelBodies).toHaveLength(0);
      expect(googleSearchCalls()).toBe(0);
    });
  }, 30_000);

  it('ledgers: one spend row priced with the Parallel searches plus the Gemini tokens; no grounded-prompt row', async () => {
    await withServer(async (server, key) => {
      expect((await postScan(server, key)).statusCode).toBe(200);
      const rows = spendRows();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      // Extraction 150 in / 40 out, two judges 80 in / 20 out, gemini-2.5-flash $0.30/$2.50 per 1M;
      // two Parallel searches at $0.005 (advanced). No grounding surcharge on any Gemini call.
      const geminiTokens = (150 * 0.30 + 40 * 2.50 + 2 * (80 * 0.30 + 20 * 2.50)) / 1_000_000;
      expect(row.costUsd).toBeCloseTo(2 * 0.005 + geminiTokens, 10);
      expect(row.provider).toBe('gemini+parallel-search');
      expect(row.modelId).toBe('parallel-search-advanced');
      expect(row.verifiedCount).toBe(2);
      expect(groundedLedgerRows()).toBe(0);

      const usage = await server.inject({ method: 'GET', url: '/usage', headers: { 'x-api-key': SERVER_KEY } });
      expect(usage.statusCode).toBe(200);
      expect(usage.json().groundingAllowance.groundedPrompts).toBe(0);
    });
  }, 30_000);

  it('FAULTLINE_PARALLEL_MODE=fast is sent and priced at $0.001 per search', async () => {
    process.env.FAULTLINE_PARALLEL_MODE = 'fast';
    await withServer(async (server, key) => {
      expect((await postScan(server, key)).statusCode).toBe(200);
      expect(parallelBodies.length).toBeGreaterThan(0);
      expect(parallelBodies.every((b) => b.mode === 'fast')).toBe(true);
      const rows = spendRows();
      expect(rows).toHaveLength(1);
      const geminiTokens = (150 * 0.30 + 40 * 2.50 + 2 * (80 * 0.30 + 20 * 2.50)) / 1_000_000;
      expect(rows[0].costUsd).toBeCloseTo(2 * 0.001 + geminiTokens, 10);
    });
  }, 30_000);

  it('a Parallel-plus-Gemini verdict stays out of the scan cache and the claim index (no rule loosened)', async () => {
    await withServer(async (server, key) => {
      const first = await postScan(server, key);
      expect(first.statusCode).toBe(200);
      const verifications = Object.values(first.json().verifications as Record<string, any>);
      expect(verifications.length).toBeGreaterThan(0);
      for (const v of verifications) expect(isGroundedVerification(v)).toBe(true);
      const second = await postScan(server, key);
      expect(second.headers['x-cache']).toBe('MISS');
      expect(parallelBodies).toHaveLength(4);
    });
  }, 30_000);

  it('POST /admin/verify-claims follows the server mode, and a body grounding picks the arm', async () => {
    await withServer(async (server) => {
      const headers = { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' };
      const claims = [{ id: 'a', text: 'The Eiffel Tower was completed in 1889.' }];
      const p = await server.inject({ method: 'POST', url: '/admin/verify-claims', headers, payload: { claims } });
      expect(p.statusCode).toBe(200);
      expect(p.json().grounding).toBe('parallel');
      expect(p.json().results.length).toBeGreaterThan(0);
      expect(p.json().results[0]).toMatchObject({ status: 'supported', apiError: false, sourcesCount: 2 });
      expect(p.json().results[0].usage).toMatchObject({ googleGroundingCalls: 0, groundingCalls: 1, priced: true });
      expect(p.json().results[0].usage.costUsd).toBeCloseTo(0.005 + (80 * 0.30 + 20 * 2.50) / 1_000_000, 10);
      expect(googleSearchCalls()).toBe(0);

      const g = await server.inject({ method: 'POST', url: '/admin/verify-claims', headers, payload: { claims, grounding: 'google' } });
      expect(g.statusCode).toBe(200);
      expect(g.json().grounding).toBe('google');
      expect(g.json().results[0].usage).toMatchObject({ googleGroundingCalls: 1, groundingCalls: 1 });
      expect(googleSearchCalls()).toBe(1);
      expect(parallelBodies).toHaveLength(1);
    });
  }, 30_000);
});

describe('FAULTLINE_GROUNDING unset: Google grounding everywhere, as before', () => {
  it.each([['a customer key', 'customer'], ['the server key', 'server']] as const)('%s POST /scan uses googleSearch and never calls Parallel', async (_label, who) => {
    await withServer(async (server, key) => {
      const res = await postScan(server, who === 'server' ? SERVER_KEY : key);
      expect(res.statusCode).toBe(200);
      const verifications = Object.values(res.json().verifications as Record<string, any>);
      expect(verifications.length).toBeGreaterThan(0);
      for (const v of verifications) expect(v.provenance).toMatchObject({ provider: 'gemini', retriever: 'gemini-grounding' });
      expect(googleSearchCalls()).toBe(2);
      expect(parallelBodies).toHaveLength(0);
      expect(fetchStub).not.toHaveBeenCalledWith(PARALLEL_URL, expect.anything());
      expect(groundedLedgerRows()).toBe(2);
    });
  }, 30_000);

  it('POST /admin/verify-claims with grounding parallel runs the Parallel arm on the same claims', async () => {
    await withServer(async (server) => {
      const res = await server.inject({
        method: 'POST', url: '/admin/verify-claims',
        headers: { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' },
        payload: { claims: [{ id: 'a', text: 'The Eiffel Tower was completed in 1889.' }], grounding: 'parallel', parallelMode: 'fast' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().grounding).toBe('parallel');
      expect(res.json().results.length).toBeGreaterThan(0);
      expect(res.json().results[0].usage.costUsd).toBeCloseTo(0.001 + (80 * 0.30 + 20 * 2.50) / 1_000_000, 10);
      expect(parallelBodies).toHaveLength(1);
      expect(parallelBodies[0].mode).toBe('fast');
      expect(googleSearchCalls()).toBe(0);
    });
  }, 30_000);
});

describe('fly-ops.yml: the Parallel key and the grounding switch', () => {
  const workflow = readFileSync(join(__dirname, '../../../.github/workflows/fly-ops.yml'), 'utf8');

  it('lists the three actions', () => {
    expect(workflow.length).toBeGreaterThan(0);
    for (const action of ['parallel-key-set', 'grounding-parallel-on', 'grounding-parallel-off']) {
      expect(workflow).toContain(`          - ${action}\n`);
      expect(workflow).toContain(`if: inputs.action == '${action}'`);
    }
  });

  it('copies the repo secret PARALLEL_API_KEY through env only, refuses an empty one, and never echoes it', () => {
    const step = workflow.slice(workflow.indexOf('- name: Parallel key set'), workflow.indexOf('- name: Grounding parallel on'));
    expect(step.length).toBeGreaterThan(0);
    expect(step).toContain('PARALLEL_KEY: ${{ secrets.PARALLEL_API_KEY }}');
    expect(step).toContain('if [ -z "$PARALLEL_KEY" ]; then');
    expect(step).toContain('flyctl secrets set PARALLEL_API_KEY="$PARALLEL_KEY" -a "$APP"');
    expect(step).not.toMatch(/echo[^\n]*\$PARALLEL_KEY/);
  });

  it('on sets FAULTLINE_GROUNDING=parallel; off unsets it', () => {
    expect(workflow).toContain('run: flyctl secrets set FAULTLINE_GROUNDING=parallel -a "$APP"');
    expect(workflow).toContain('run: flyctl secrets unset FAULTLINE_GROUNDING -a "$APP"');
  });
});
