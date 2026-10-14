// Validates: N-234 (independent passage leg on the API, GoPMO 1.18.11.3; emma-soul authorization al:e615798a8e8109c0)
/**
 * Behind FAULTLINE_PASSAGE_LEG=on, POST /scan runs OpenAI web_search on each
 * verified claim, fetches its result pages through the guarded fetch and
 * quotes them into independentEvidence. Gemini's own grounding Links stay
 * unfetched. Off by default. Mocked: the Google SDK, the OpenAI HTTP endpoint
 * and the outbound network; route, engine, retriever parsing and guard are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GROUNDED = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/kestrel';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { config?: { tools?: Array<Record<string, unknown>> } }) => {
        const grounded = (params.config?.tools ?? []).some((t) => 'googleSearch' in t);
        if (grounded) {
          return {
            text: '{"status":"supported","explanation":"Completed in 1889."}',
            modelVersion: 'gemini-2.5-flash',
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
            candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: 'g', uri: GROUNDED } }] } }],
          };
        }
        return {
          text: JSON.stringify([{ id: 'c1', text: 'The Eiffel Tower was completed in 1889.', type: 'fact', importance: 5 }]),
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 40 },
        };
      },
    };
  },
}));

import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';
import { setOutboundFetch, resetOutboundFetch, setOutboundResolver, resetOutboundResolver } from '../src/lib/outbound-url.js';
import { clearRobotsCache } from '@nxtg/faultline/evidence/robots.js';
import { priceLeg } from '../src/store/consensus-cost.js';

const PAGE = '<html><body><p>The Eiffel Tower was completed in March 1889 for the Exposition Universelle.</p></body></html>';
const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'FAULTLINE_CONSENSUS',
  'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_OUTBOUND_ALLOW_PRIVATE', 'FAULTLINE_PASSAGE_LEG', 'FAULTLINE_PASSAGE_SEARCH_MODEL'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
const pageRequests: string[] = [];
const openaiBodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ['FAULTLINE_CONSENSUS', 'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_OUTBOUND_ALLOW_PRIVATE', 'FAULTLINE_PASSAGE_SEARCH_MODEL']) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-passage-leg-'));
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.OPENAI_API_KEY = 'test-openai';
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetCache();
  pageRequests.length = 0;
  clearRobotsCache();
  openaiBodies.length = 0;
  setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  setOutboundFetch(async (url) => {
    pageRequests.push(url);
    return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
  });
  // The retriever calls OpenAI with the global fetch.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (!String(url).startsWith('https://api.openai.com/')) throw new Error(`unexpected global fetch ${url}`);
    openaiBodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'It was completed in 1889 [1].',
        annotations: [{ type: 'url_citation', title: 'Kestrel Archive', url: 'https://kestrel.example/eiffel', start_index: 0, end_index: 10 }] }] }],
      usage: { input_tokens: 8174, output_tokens: 300 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetOutboundFetch();
  resetOutboundResolver();
  uninstallGroundingCounter();
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function postScan(): Promise<Record<string, any>> {
  const server = buildServer();
  await server.ready();
  try {
    const apiKey = getKeyStore().create('Pro', ['pro', 'scan']).key;
    const res = await server.inject({
      method: 'POST', url: '/scan',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      payload: { text: 'The Eiffel Tower was completed in 1889.', provider: 'gemini' },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  } finally {
    await server.close();
  }
}

describe('passage leg', () => {
  it('on: OpenAI result pages are quoted into independentEvidence; Gemini Links stay unfetched', async () => {
    process.env.FAULTLINE_PASSAGE_LEG = 'on';
    const body = await postScan();
    const v = body.verifications.c1;
    expect(v.sources[0].evidence).toEqual({ status: 'not_fetched', reason: 'provider_terms', passage: null });
    expect(v.independentEvidence.retriever).toBe('openai-web-search');
    expect(v.independentEvidence.model).toBe('gpt-4o-mini');
    expect(v.independentEvidence.sources[0]).toMatchObject({ title: 'Kestrel Archive', uri: 'https://kestrel.example/eiffel' });
    expect(v.independentEvidence.sources[0].evidence.status).toBe('ok');
    expect(v.independentEvidence.sources[0].evidence.passage).toBe('The Eiffel Tower was completed in March 1889 for the Exposition Universelle.');
    // The publisher's robots.txt is asked first, then the page.
    expect(pageRequests).toEqual(['https://kestrel.example/robots.txt', 'https://kestrel.example/eiffel']);
    expect(openaiBodies).toHaveLength(1);
    expect(openaiBodies[0].model).toBe('gpt-4o-mini');
    expect(openaiBodies[0].tools).toEqual([{ type: 'web_search' }]);
  }, 30_000);

  it('off by default: OpenAI is never called and no independentEvidence appears', async () => {
    const body = await postScan();
    expect(body.verifications.c1.independentEvidence).toBeUndefined();
    expect(openaiBodies).toHaveLength(0);
  }, 30_000);

  it('on without an OpenAI key: stays off', async () => {
    process.env.FAULTLINE_PASSAGE_LEG = 'on';
    delete process.env.OPENAI_API_KEY;
    const body = await postScan();
    expect(body.verifications.c1.independentEvidence).toBeUndefined();
    expect(openaiBodies).toHaveLength(0);
  }, 30_000);
});

describe('passage leg guards (Fable review findings)', () => {
  async function postAs(provider: 'gemini' | 'mock'): Promise<Record<string, any>> {
    const server = buildServer();
    await server.ready();
    try {
      const apiKey = getKeyStore().create('Pro', ['pro', 'scan']).key;
      const res = await server.inject({ method: 'POST', url: '/scan', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        payload: { text: 'The Eiffel Tower was completed in 1889.', provider } });
      expect(res.statusCode).toBe(200);
      return res.json();
    } finally {
      await server.close();
    }
  }

  it('FAULTLINE_EVIDENCE_FETCH=off also stops the leg (L1)', async () => {
    process.env.FAULTLINE_PASSAGE_LEG = 'on';
    process.env.FAULTLINE_EVIDENCE_FETCH = 'off';
    const body = await postAs('gemini');
    expect(body.verifications.c1.independentEvidence).toBeUndefined();
    expect(openaiBodies).toHaveLength(0);
  }, 30_000);

  it('a model not measured under the cap leaves the leg off (L2)', async () => {
    process.env.FAULTLINE_PASSAGE_LEG = 'on';
    process.env.FAULTLINE_PASSAGE_SEARCH_MODEL = 'gpt-4.1-mini';
    const body = await postAs('gemini');
    expect(body.verifications.c1.independentEvidence).toBeUndefined();
    expect(openaiBodies).toHaveLength(0);
  }, 30_000);

  it('a verdict that is not Gemini-grounded gets no search, so a mock scan spends nothing (L3)', async () => {
    process.env.FAULTLINE_PASSAGE_LEG = 'on';
    const body = await postAs('mock');
    for (const v of Object.values(body.verifications as Record<string, any>)) expect(v.independentEvidence).toBeUndefined();
    expect(openaiBodies).toHaveLength(0);
  }, 30_000);

  it('the search call carries a deadline (M1)', async () => {
    process.env.FAULTLINE_PASSAGE_LEG = 'on';
    await postAs('gemini');
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).startsWith('https://api.openai.com/'));
    expect(call).toBeDefined();
    expect((call![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  }, 30_000);
});

describe('price of the passage leg', () => {
  it('a gpt-4o-mini web_search leg includes the 1 cent call fee; a non-grounding leg does not', () => {
    const search = priceLeg({ provider: 'openai', model: 'gpt-4o-mini', callType: 'web_search', inputTokens: 8174, outputTokens: 300, isGrounding: true });
    expect(search).toBeCloseTo(0.010 + 8174 * 0.15 / 1e6 + 300 * 0.60 / 1e6, 8);
    expect(search).toBeLessThanOrEqual(0.015);
    const voter = priceLeg({ provider: 'openai', model: 'gpt-4o-mini', callType: 'grounded-verify:openai', inputTokens: 1000, outputTokens: 100, isGrounding: false });
    expect(voter).toBeCloseTo(1000 * 0.15 / 1e6 + 100 * 0.60 / 1e6, 8);
  });
});
