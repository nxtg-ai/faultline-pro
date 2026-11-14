// Validates: GoPMO 1.18.11.7.127 (owner's ruling, option C): a judge call Google
// rate-limits on FAULTLINE_GEMINI_MODEL is retried once on FAULTLINE_GEMINI_FALLBACK_MODEL,
// and the hosted API reports the model that actually judged each claim.
/**
 * Real path: route → verify runner → Parallel retriever and geminiService, with only
 * the Gemini SDK mocked at the module boundary and global fetch stubbed for Parallel's
 * endpoint. The two model settings are read when the engine module loads, so they are
 * set in vi.hoisted, before any import.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PRIMARY = 'gemini-3.1-pro-preview';
const FALLBACK = 'gemini-3.8-flash';

const sdk = vi.hoisted(() => {
  process.env.FAULTLINE_GEMINI_MODEL = 'gemini-3.1-pro-preview';
  process.env.FAULTLINE_GEMINI_FALLBACK_MODEL = 'gemini-3.8-flash';
  return { models: [] as string[], fallbackFails: false };
});

const rateLimited = () => new Error('got status: 429 Too Many Requests. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { model: string; contents?: unknown; config?: Record<string, any> }) => {
        sdk.models.push(params.model);
        // Every primary call is rate-limited; the fallback answers unless told to fail too.
        if (params.model === 'gemini-3.1-pro-preview') throw rateLimited();
        if (sdk.fallbackFails) throw rateLimited();
        const grounded = (params.config?.tools ?? []).some((t: Record<string, unknown>) => 'googleSearch' in t);
        if (grounded) {
          return {
            text: '{"status":"supported","sourcesAddressClaim":true,"explanation":"Google grounded."}',
            modelVersion: params.model,
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
            candidates: [{ finishReason: 'STOP', groundingMetadata: { groundingChunks: [{ web: { title: 'G', uri: 'https://google-grounded.example/page' } }] } }],
          };
        }
        return {
          text: '{"status":"supported","sourcesAddressClaim":true,"explanation":"Judged against the supplied excerpts."}',
          usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20 },
          candidates: [{ finishReason: 'STOP' }],
        };
      },
    };
  },
}));

import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { CONSENSUS_MODEL_RATES } from '../src/store/consensus-cost.js';

const SERVER_KEY = 'judge-fallback-server-key-0123456789';
const PARALLEL_URL = 'https://api.parallel.ai/v1/search';
const ENV_KEYS = [
  'FAULTLINE_API_KEY', 'FAULTLINE_GROUNDING', 'FAULTLINE_PARALLEL_MODE', 'PARALLEL_API_KEY', 'GEMINI_API_KEY',
  'FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_CONSENSUS',
  'FAULTLINE_RETRIEVAL_CACHE_DIR', 'FAULTLINE_RETRIEVAL_CACHE_MODE',
];
let saved: Record<string, string | undefined>;
let dir: string;

const fetchStub = vi.fn(async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url !== PARALLEL_URL) return new Response('not stubbed', { status: 404 });
  return new Response(JSON.stringify({
    search_id: 'search_1',
    results: [
      { url: 'https://history.example/eiffel', title: 'Eiffel history', publish_date: '2020-01-02', excerpts: ['Completed in March 1889.'] },
      { url: 'https://geo.example/everest', title: 'Everest', publish_date: null, excerpts: ['8,849 m above sea level.'] },
    ],
    usage: [{ name: 'sku_search', count: 1 }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
});

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'fl-judge-fallback-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.PARALLEL_API_KEY = 'test-parallel';
  delete process.env.FAULTLINE_CONSENSUS;
  delete process.env.FAULTLINE_GROUNDING;
  delete process.env.FAULTLINE_PARALLEL_MODE;
  delete process.env.FAULTLINE_RETRIEVAL_CACHE_DIR;
  delete process.env.FAULTLINE_RETRIEVAL_CACHE_MODE;
  process.env.FAULTLINE_GROUNDING_LEDGER = join(dir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(dir, 'provider-spend.jsonl');
  sdk.models.length = 0;
  sdk.fallbackFails = false;
  fetchStub.mockClear();
  vi.stubGlobal('fetch', fetchStub);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
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
  rmSync(dir, { recursive: true, force: true });
});

async function withServer<T>(fn: (server: ReturnType<typeof buildServer>) => Promise<T>): Promise<T> {
  const server = buildServer();
  await server.ready();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function spendRows(): Array<Record<string, any>> {
  const path = process.env.FAULTLINE_PROVIDER_SPEND_LEDGER!;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const verify = (server: ReturnType<typeof buildServer>, payload: Record<string, unknown>) => server.inject({
  method: 'POST', url: '/admin/verify-claims',
  headers: { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' },
  payload,
});

const CLAIMS = [
  { id: 'a', text: 'The Eiffel Tower was completed in 1889.' },
  { id: 'b', text: 'Mount Everest is the highest mountain above sea level.' },
];

describe('POST /admin/verify-claims: judgeModel names the model that judged', () => {
  it('parallel arm, primary rate-limited: every claim is judged by the fallback and priced at its rates', async () => {
    await withServer(async (server) => {
      const res = await verify(server, { claims: CLAIMS, grounding: 'parallel', parallelMode: 'fast' });
      expect(res.statusCode).toBe(200);
      const results = res.json().results as Array<Record<string, any>>;
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r).toMatchObject({ status: 'supported', apiError: false, judgeModel: FALLBACK, judgeFallback: true });
        // One Parallel search (fast, $0.001) plus the judge's tokens at the fallback model's rates.
        const rate = CONSENSUS_MODEL_RATES[FALLBACK];
        expect(r.usage.costUsd).toBeCloseTo(0.001 + (80 * rate.inputPerM + 20 * rate.outputPerM) / 1_000_000, 10);
      }
      expect(sdk.models.filter((m) => m === PRIMARY)).toHaveLength(2);
      expect(sdk.models.filter((m) => m === FALLBACK)).toHaveLength(2);
      expect(spendRows().length).toBeGreaterThan(0);
    });
  }, 30_000);

  it('Google arm, primary rate-limited: the fallback judges, and judgeModel says so', async () => {
    await withServer(async (server) => {
      const res = await verify(server, { claims: CLAIMS.slice(0, 1), grounding: 'google' });
      expect(res.statusCode).toBe(200);
      expect(res.json().results[0]).toMatchObject({ status: 'supported', apiError: false, judgeModel: FALLBACK, judgeFallback: true, model: FALLBACK });
      expect(sdk.models).toEqual([PRIMARY, FALLBACK]);
    });
  }, 30_000);

  it('fallback rate-limited too: not checked, no judge model, never the primary', async () => {
    sdk.fallbackFails = true;
    await withServer(async (server) => {
      for (const grounding of ['parallel', 'google']) {
        const res = await verify(server, { claims: CLAIMS.slice(0, 1), grounding, parallelMode: 'fast' });
        expect(res.statusCode).toBe(200);
        expect(res.json().results[0]).toMatchObject({ status: 'unverified', apiError: true, judgeModel: null, judgeFallback: false, model: null });
      }
      expect(sdk.models).toEqual([PRIMARY, FALLBACK, PRIMARY, FALLBACK]);
    });
  }, 30_000);
});

describe('GET /health names the judge fallback model', () => {
  it('models.fallback is FAULTLINE_GEMINI_FALLBACK_MODEL', async () => {
    await withServer(async (server) => {
      const body = (await server.inject({ method: 'GET', url: '/health' })).json();
      expect(body.models).toEqual({ judge: PRIMARY, extraction: PRIMARY, fallback: FALLBACK });
    });
  });
});
