/**
 * POST /scan reports a reply cut off at its output ceiling as an unchecked
 * claim with reason 'output_truncated' (GoPMO 1.18.11.7.18): never a verdict,
 * the scan is degraded, the claim is not counted as verified in the cost log,
 * and the scan is not cached. faultline-web bills a claim free when it carries
 * apiError (fw al:78275c292aa09eac), so this shape is the contract. A cut-off
 * extraction is a 502 extraction_failed with that reason, never fewer claims.
 *
 * Only the Gemini SDK (and, for the fallback-chain case, global fetch) is mocked:
 * route, engine scan(), geminiService and the provider adapters run for real, so
 * each wire's cut-off check is exercised on the production path.
 */
// Validates: N-234 (billable unit and cost ceilings, GoPMO 1.18.11.7.18)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sdk = vi.hoisted(() => ({ extractCut: false, groundedCalls: 0, configs: [] as Array<Record<string, unknown>> }));
const CLAIMS = [
  { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 4 },
  { id: 'c2', text: 'It opened in 1889.', type: 'fact', importance: 3 },
];

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (req: { contents: unknown; config?: { tools?: unknown[] } & Record<string, unknown> }) => {
        sdk.configs.push(req.config ?? {});
        const usageMetadata = { promptTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 30 };
        if (!(req.config?.tools ?? []).length) {
          // Extraction: a cut-off reply still holds a parseable claim array.
          return { text: JSON.stringify(CLAIMS), usageMetadata, candidates: [{ finishReason: sdk.extractCut ? 'MAX_TOKENS' : 'STOP' }] };
        }
        sdk.groundedCalls += 1;
        const cut = String(req.contents).includes('Eiffel');
        return {
          text: '{"status":"supported","explanation":"Matches the record."}',
          usageMetadata,
          candidates: [{
            finishReason: cut ? 'MAX_TOKENS' : 'STOP',
            groundingMetadata: { groundingChunks: [{ web: { title: 'Source', uri: 'https://publisher.example/a' } }] },
          }],
        };
      },
    };
  },
}));

import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { getCostStore, resetCostStore } from '../src/store/costs.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetCache } from '../src/store/cache.js';
import { resetGroundingAllowanceLedger, uninstallGroundingCounter } from '../src/store/grounding-allowance.js';

const SERVER_KEY = 'test-truncated-server-key';
const ENV_KEYS = [
  'FAULTLINE_API_KEY', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP', 'FAULTLINE_GROUNDING_LEDGER',
  'FAULTLINE_CONSENSUS', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY',
];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let server: FastifyInstance;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'truncated-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  for (const k of ['FAULTLINE_PROVIDER_SPEND_CAP', 'FAULTLINE_CONSENSUS', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY']) delete process.env[k];
  process.env.GEMINI_API_KEY = 'fixture-key';
  sdk.extractCut = false;
  sdk.groundedCalls = 0;
  sdk.configs.length = 0;
  resetKeyStore(); resetRateLimiter(); resetUsageMeter(); resetCostStore();
  resetProviderSpendLedger(); resetCircuitBreaker(); resetCache(); resetGroundingAllowanceLedger();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  uninstallGroundingCounter();
  resetGroundingAllowanceLedger();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

const scan = () => server.inject({
  method: 'POST', url: '/scan',
  headers: { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' },
  payload: JSON.stringify({ text: 'The Eiffel Tower is in Paris. It opened in 1889.', provider: 'gemini' }),
});

describe('POST /scan with a reply cut off at its output ceiling', () => {
  it('reports the claim unchecked with reason output_truncated, never a verdict, and the scan degraded', async () => {
    const res = await scan();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verifications.c1).toMatchObject({ status: 'unverified', apiError: true, apiErrorReason: 'output_truncated', sources: [] });
    expect(body.verifications.c1.provenance).toBeUndefined();
    expect(body.verifications.c2).toMatchObject({ status: 'supported' });
    expect(body.verifications.c2.apiError).toBeUndefined();
    expect(body.degraded).toBe(true);
  });

  it('sent every Gemini request with its ceiling and thinking budget', async () => {
    await scan();
    expect(sdk.configs.length).toBeGreaterThan(0);
    for (const config of sdk.configs) {
      expect(config.maxOutputTokens).toEqual(expect.any(Number));
      expect((config.thinkingConfig as { thinkingBudget?: unknown } | undefined)?.thinkingBudget).toEqual(expect.any(Number));
    }
  });

  it('counts only the whole verdict as verified in the cost log, and does not cache the scan', async () => {
    await scan();
    const events = getCostStore().getManagedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ claimsExtracted: 2, claimsVerified: 1 });
    expect(sdk.groundedCalls).toBe(2);
    await scan();
    expect(sdk.groundedCalls).toBe(4);
  });

  it('a cut-off extraction on every provider in the chain is 502 extraction_failed with reason output_truncated', async () => {
    // The route falls back gemini → openai → claude → perplexity; each wire reports the cut-off its own way.
    sdk.extractCut = true;
    process.env.OPENAI_API_KEY = 'fixture-openai';
    process.env.ANTHROPIC_API_KEY = 'fixture-anthropic';
    process.env.PERPLEXITY_API_KEY = 'fixture-perplexity';
    const claims = JSON.stringify({ claims: CLAIMS });
    const wireCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) });
      if (u.includes('api.anthropic.com')) {
        wireCalls.push('claude');
        return json({ content: [{ type: 'text', text: JSON.stringify(CLAIMS) }], stop_reason: 'max_tokens', usage: {} });
      }
      if (u.includes('api.openai.com') || u.includes('api.perplexity.ai')) {
        wireCalls.push(u.includes('openai') ? 'openai' : 'perplexity');
        return json({ choices: [{ message: { content: claims }, finish_reason: 'length' }], usage: {} });
      }
      return json({});
    }));
    try {
      const res = await scan();
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'extraction_failed', reason: 'output_truncated' });
      expect(wireCalls).toEqual(expect.arrayContaining(['openai', 'claude', 'perplexity']));
      expect(sdk.groundedCalls).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
