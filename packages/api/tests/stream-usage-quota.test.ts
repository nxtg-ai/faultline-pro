/**
 * /scan/stream counts a scan toward the monthly quota only when its result
 * holds at least one billable verdict: supported, contradicted or mixed, with
 * at least one source, a retriever the engine bound, and not an API error. A
 * scan where every claim failed at the provider, or came back unverified,
 * delivered nothing billable, so it costs the customer no scan. Of the
 * single-provider scans only the built-in gemini provider gets the engine's
 * retriever, so the scan that must count runs on gemini with only the Google
 * SDK mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { getUsageMeter, resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';

type Outcome = 'error' | 'unverified' | 'mixed-errors' | 'one-billable';
const fixture = { outcome: 'error' as Outcome };

const CLAIMS = [
  { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 5 },
  { id: 'c2', text: 'Water boils at 100 degrees Celsius at sea level.', type: 'fact', importance: 5 },
];

const failed = (id: string) => ({
  claimId: id, status: 'unverified', explanation: 'The provider failed, so this claim was not checked.',
  sources: [], apiError: true, apiErrorReason: 'provider_unavailable',
});
const inconclusive = (id: string) => ({ claimId: id, status: 'unverified', explanation: 'Inconclusive.', sources: [] });

// The built-in 'mock' provider is replaced for this file only, through the
// module mock: the production registry refuses to replace a built-in id.
vi.mock('@nxtg/faultline/providers/mock_provider.js', () => ({
  createMockProvider: () => ({
    name: 'Stream quota fixture',
    modelId: 'fixture-v1',
    extractClaims: async () => CLAIMS,
    verifyClaim: async (c: { id: string }) => {
      if (fixture.outcome === 'error') return failed(c.id);
      if (fixture.outcome === 'unverified') return inconclusive(c.id);
      return c.id === 'c1' ? failed(c.id) : inconclusive(c.id);
    },
    generateCritiqueAndPrompt: async () => ({ critique: '', improvedPrompt: '' }),
  }) as never,
}));

// The 'one-billable' scan runs on the real built-in gemini provider: the Google
// SDK gives c1 a grounded, sourced supported verdict and fails c2's search, so
// c2 comes back an API error.
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { config?: { tools?: Array<Record<string, unknown>> } }) => {
        const grounded = (params.config?.tools ?? []).some((t) => 'googleSearch' in t);
        if (!grounded) {
          return { text: JSON.stringify(CLAIMS), usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 40 } };
        }
        if (JSON.stringify(params).includes(CLAIMS[1].text)) throw new Error('503 Service Unavailable: the model is overloaded');
        return {
          text: JSON.stringify({ status: 'supported', explanation: 'Found.' }),
          modelVersion: 'gemini-2.5-flash',
          usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
          candidates: [{ groundingMetadata: { groundingChunks: [{ web: { title: 'Publisher', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x' } }] } }],
        };
      },
    };
  },
}));

const ENV_KEYS = ['FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_CONSENSUS', 'FAULTLINE_GROUNDING_LEDGER', 'GEMINI_API_KEY'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-stream-quota-'));
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.FAULTLINE_EVIDENCE_FETCH = 'off';
  delete process.env.FAULTLINE_CONSENSUS;
  resetGroundingAllowanceLedger();
  resetCircuitBreaker();
  resetProviderSpendLedger();
  resetKeyStore();
  resetUsageMeter();
  resetCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  uninstallGroundingCounter();
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function runStream(method: 'GET' | 'POST', outcome: Outcome): Promise<{ count: number; verdicts: number }> {
  fixture.outcome = outcome;
  const entry = getKeyStore().create('quota', ['pro', 'scan']);
  const server = buildServer();
  await server.ready();
  try {
    const text = 'The Eiffel Tower is in Paris. Water boils at 100 degrees Celsius at sea level.';
    const provider = outcome === 'one-billable' ? 'gemini' : 'mock';
    const res = method === 'POST'
      ? await server.inject({
        method: 'POST', url: '/scan/stream',
        headers: { 'x-api-key': entry.key, 'content-type': 'application/json' },
        payload: JSON.stringify({ text, provider }),
      })
      : await server.inject({
        method: 'GET', url: `/scan/stream?provider=${provider}&text=${encodeURIComponent(text)}`,
        headers: { 'x-api-key': entry.key },
      });
    expect(res.statusCode).toBe(200);
    const verdicts = res.body.split('\n\n').filter((c) => c.includes('"claim_verified"')).length;
    return { count: getUsageMeter().getMonthlyCount(entry.id), verdicts };
  } finally {
    await server.close();
  }
}

describe.each(['GET', 'POST'] as const)('%s /scan/stream monthly usage', (method) => {
  it('every claim an API error: the scan is not counted', async () => {
    const { count, verdicts } = await runStream(method, 'error');
    expect(verdicts).toBe(2);
    expect(count).toBe(0);
  });

  it('one claim inconclusive, one an API error: nothing billable, the scan is not counted', async () => {
    const { count, verdicts } = await runStream(method, 'mixed-errors');
    expect(verdicts).toBe(2);
    expect(count).toBe(0);
  });

  it('every claim checked and inconclusive: nothing billable, the scan is not counted', async () => {
    const { count, verdicts } = await runStream(method, 'unverified');
    expect(verdicts).toBe(2);
    expect(count).toBe(0);
  });

  it('one sourced supported verdict, one an API error: the scan is counted once', async () => {
    const { count, verdicts } = await runStream(method, 'one-billable');
    expect(verdicts).toBe(2);
    expect(count).toBe(1);
  });
});
