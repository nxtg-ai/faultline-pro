// Validates: typed secondary retrieval status (the hosted API passes evidenceCoverage through on POST /scan and the /scan/stream complete event)
/**
 * With the independent search on and every OpenAI call failing with HTTP 500,
 * POST /scan and both /scan/stream variants report the same evidenceCoverage.
 * Mocked: the Google SDK, the OpenAI HTTP endpoint and the outbound network;
 * route, engine and retriever are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GROUNDED = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/kestrel';
const SCAN_TEXT = 'The Eiffel Tower was completed in 1889.';

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

const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'FAULTLINE_CONSENSUS',
  'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_OUTBOUND_ALLOW_PRIVATE', 'FAULTLINE_PASSAGE_LEG', 'FAULTLINE_PASSAGE_SEARCH_MODEL'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
const pageRequests: string[] = [];
let openaiCalls = 0;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ['FAULTLINE_CONSENSUS', 'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_OUTBOUND_ALLOW_PRIVATE', 'FAULTLINE_PASSAGE_SEARCH_MODEL']) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-evidence-coverage-'));
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.OPENAI_API_KEY = 'test-openai';
  process.env.FAULTLINE_PASSAGE_LEG = 'on';
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetCache();
  clearRobotsCache();
  pageRequests.length = 0;
  openaiCalls = 0;
  setOutboundResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  setOutboundFetch(async (url) => {
    pageRequests.push(url);
    return new Response('', { status: 404 });
  });
  // The independent search calls OpenAI with the global fetch: every call fails.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!String(url).startsWith('https://api.openai.com/')) throw new Error(`unexpected global fetch ${url}`);
    openaiCalls++;
    return new Response('{"error":{"message":"upstream body that must not leak"}}', { status: 500, statusText: 'Internal Server Error' });
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

function parseSSE(body: string): Array<Record<string, any>> {
  return body.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
}

describe('evidenceCoverage on the hosted API', () => {
  it('POST /scan and the /scan/stream complete event carry the same evidenceCoverage', async () => {
    const server = buildServer();
    await server.ready();
    try {
      const apiKey = getKeyStore().create('Pro', ['pro', 'scan']).key;
      const headers = { 'x-api-key': apiKey, 'content-type': 'application/json' };

      const scanRes = await server.inject({ method: 'POST', url: '/scan', headers, payload: { text: SCAN_TEXT, provider: 'gemini' } });
      expect(scanRes.statusCode).toBe(200);
      const body = scanRes.json();
      expect(Object.keys(body.verifications).length).toBeGreaterThan(0);
      expect(body.verifications.c1.independentEvidence.status).toBe('provider_error');
      expect(body.verifications.c1.independentEvidence.detail).toBe('http 500');
      expect(body.evidenceCoverage).toEqual({ state: 'partial', checked: 1, corroborated: 0, byStatus: { provider_error: 1 } });
      expect(scanRes.body).not.toContain('must not leak');

      const postStream = await server.inject({ method: 'POST', url: '/scan/stream', headers, payload: { text: SCAN_TEXT, provider: 'gemini' } });
      expect(postStream.statusCode).toBe(200);
      const postEvents = parseSSE(postStream.body);
      expect(postEvents.length).toBeGreaterThan(0);
      const postComplete = postEvents.find((e) => e.type === 'complete');
      expect(postComplete).toBeDefined();
      expect(postComplete!.evidenceCoverage).toEqual(body.evidenceCoverage);

      const getStream = await server.inject({
        method: 'GET', url: `/scan/stream?text=${encodeURIComponent(SCAN_TEXT)}&provider=gemini`, headers: { 'x-api-key': apiKey },
      });
      expect(getStream.statusCode).toBe(200);
      const getEvents = parseSSE(getStream.body);
      expect(getEvents.length).toBeGreaterThan(0);
      const getComplete = getEvents.find((e) => e.type === 'complete');
      expect(getComplete).toBeDefined();
      expect(getComplete!.evidenceCoverage).toEqual(body.evidenceCoverage);

      // One failed search per scan; no result page was fetched after a failed search.
      expect(openaiCalls).toBe(3);
      expect(pageRequests).toEqual([]);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('the leg off: no evidenceCoverage on /scan or the complete event', async () => {
    delete process.env.FAULTLINE_PASSAGE_LEG;
    const server = buildServer();
    await server.ready();
    try {
      const apiKey = getKeyStore().create('Pro', ['pro', 'scan']).key;
      const headers = { 'x-api-key': apiKey, 'content-type': 'application/json' };
      const scanRes = await server.inject({ method: 'POST', url: '/scan', headers, payload: { text: SCAN_TEXT, provider: 'gemini' } });
      expect(scanRes.statusCode).toBe(200);
      const body = scanRes.json();
      expect(Object.keys(body.verifications).length).toBeGreaterThan(0);
      expect(body).not.toHaveProperty('evidenceCoverage');
      const stream = await server.inject({ method: 'POST', url: '/scan/stream', headers, payload: { text: SCAN_TEXT, provider: 'gemini' } });
      const complete = parseSSE(stream.body).find((e) => e.type === 'complete');
      expect(complete).toBeDefined();
      expect(complete).not.toHaveProperty('evidenceCoverage');
      expect(openaiCalls).toBe(0);
    } finally {
      await server.close();
    }
  }, 30_000);
});
