// Validates: every engine call the API makes lands in the provider-spend ledger, and consensus is Enterprise only and runs only with voters that can vote.
/**
 * Two gaps in POST /scan and POST /scan/stream, each reproduced here against the
 * real provider registry with the network stubbed.
 *
 * 1. Spend left unledgered. The Perplexity adapter reported no usage, and the
 *    fallback estimate was priced by the outer `provider` label. So a /scan with
 *    provider 'mock' whose stages all ran on Perplexity priced at $0 and wrote no
 *    row, and a billed Perplexity extraction whose reply could not be read wrote
 *    no row either.
 *
 * 2. Consensus with no usable voter. consensusProviders [] or ['perplexity']
 *    answered 200 with providerCount 0, degraded false and a verified claim, used
 *    a scan of quota and wrote a spend row. Such a request is now refused with a
 *    400 before any provider call. A consensus run that ends with no voter taking
 *    part reports failure and uses no quota.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { getUsageMeter, resetUsageMeter } from '../src/store/usage.js';
import { resetCache } from '../src/store/cache.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetCostStore } from '../src/store/costs.js';

// Counts every provider the engine builds, to show a refused request reached none.
const getProviderSpy = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  return {
    ...actual,
    getProvider: vi.fn((...args: Parameters<typeof actual.getProvider>) => {
      getProviderSpy.calls += 1;
      return actual.getProvider(...args);
    }),
  };
});

const SERVER_KEY = 'voters-and-perplexity-spend-server-key';
// The server's own key authenticates as keyId 'admin': the key whose quota is counted.
const QUOTA_KEY_ID = 'admin';
const TEXT = 'Paris is in France.';
const ENV_KEYS = [
  'FAULTLINE_API_KEY', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP',
  'PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'FAULTLINE_PERPLEXITY_MODEL',
];

const EXTRACTION_REPLY = JSON.stringify({ claims: [{ id: 'c1', text: 'Paris is in France', type: 'fact', importance: 5 }] });
const VERDICT_REPLY = JSON.stringify({ status: 'supported', explanation: 'Paris is the capital of France.' });

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let spendLedger: string;
let server: FastifyInstance;
/** What the stubbed Perplexity endpoint answers to an extraction request. */
let extractionContent: string;
let perplexityCalls: number;

const headers = { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' };

function spendRows(): Array<Record<string, unknown>> {
  if (!existsSync(spendLedger)) return [];
  return readFileSync(spendLedger, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function quotaUsed(): number {
  return getUsageMeter().getMonthlyCount(QUOTA_KEY_ID);
}

/** A Perplexity Chat Completions reply that reports billed usage; every other host fails. */
function stubNetwork(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: { body?: string }) => {
    const target = String(url);
    if (target.startsWith('https://api.perplexity.ai/')) {
      perplexityCalls += 1;
      const isExtraction = String(init?.body ?? '').includes('decompose it into atomic claims');
      return new Response(JSON.stringify({
        choices: [{ message: { content: isExtraction ? extractionContent : VERDICT_REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
        citations: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('upstream unavailable in tests', { status: 500, statusText: 'Internal Server Error' });
  }));
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-voters-spend-'));
  spendLedger = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = spendLedger;
  process.env.PERPLEXITY_API_KEY = 'test-perplexity-key';
  delete process.env.FAULTLINE_PROVIDER_SPEND_CAP;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FAULTLINE_PERPLEXITY_MODEL;
  extractionContent = EXTRACTION_REPLY;
  perplexityCalls = 0;
  getProviderSpy.calls = 0;
  stubNetwork();
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  resetCircuitBreaker();
  resetCostStore();
  resetProviderSpendLedger();
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetProviderSpendLedger();
  resetKeyStore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Perplexity spend reaches the ledger, priced by the provider that ran it', () => {
  it('a /scan labelled mock whose stages ran on Perplexity writes a priced Perplexity row', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan', headers,
      payload: { text: TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'perplexity', verificationProvider: 'perplexity' } },
    });
    expect(res.statusCode).toBe(200);
    expect(perplexityCalls).toBe(2);

    const rows = spendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('perplexity');
    expect(rows[0].modelId).toBe('sonar-pro');
    // Two sonar-pro calls of 1,200 input and 300 output tokens at $3 / $15 per million,
    // plus the $0.006 request fee on each: 2 × (0.0036 + 0.0045 + 0.006) = $0.0282.
    expect(rows[0].costUsd).toBeCloseTo(0.0282, 6);
  });

  it('a billed Perplexity extraction that returns unusable output still writes its row', async () => {
    extractionContent = 'not json at all';
    const res = await server.inject({
      method: 'POST', url: '/scan', headers,
      payload: { text: TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'perplexity', verificationProvider: 'perplexity' } },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('extraction_failed');
    expect(perplexityCalls).toBe(1);

    const rows = spendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('perplexity');
    expect(rows[0].claimCount).toBe(0);
    expect(rows[0].costUsd).toBeCloseTo(0.0141, 6);
    expect(quotaUsed()).toBe(0);
  });

  it('the same on POST /scan/stream: a priced Perplexity row, never a $0 mock row', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/stream', headers,
      payload: { text: TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'perplexity', verificationProvider: 'perplexity' } },
    });
    expect(res.body).toContain('"type":"complete"');
    const rows = spendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('perplexity');
    expect(rows[0].costUsd).toBeCloseTo(0.0282, 6);
  });
});

describe('consensus with no usable voter is refused before any provider call', () => {
  const cases: Array<{ name: string; consensusProviders: string[]; error: string }> = [
    { name: 'an empty voter list', consensusProviders: [], error: 'consensus_providers_empty' },
    { name: 'a provider that cannot vote (perplexity)', consensusProviders: ['perplexity'], error: 'consensus_provider_cannot_vote' },
    { name: 'a voter list mixing a voter with one that cannot vote', consensusProviders: ['mock', 'perplexity'], error: 'consensus_provider_cannot_vote' },
  ];

  for (const url of ['/scan', '/scan/stream']) {
    for (const c of cases) {
      it(`POST ${url}: ${c.name} → 400, no provider call, no quota, no spend row`, async () => {
        const res = await server.inject({
          method: 'POST', url, headers,
          payload: { text: TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'mock', consensus: true, consensusProviders: c.consensusProviders } },
        });
        expect(res.statusCode).toBe(400);
        expect(String(res.headers['content-type'])).toContain('application/json');
        expect(res.json().error).toBe(c.error);
        expect(res.json().voters).toEqual(['openai', 'gemini', 'claude', 'mock']);
        expect(getProviderSpy.calls).toBe(0);
        expect(perplexityCalls).toBe(0);
        expect(quotaUsed()).toBe(0);
        expect(spendRows()).toHaveLength(0);
      });
    }

    it(`POST ${url}: an unknown provider is refused with 400 by the schema, no provider call`, async () => {
      const res = await server.inject({
        method: 'POST', url, headers,
        payload: { text: TEXT, provider: 'mock', pipelineConfig: { consensus: true, consensusProviders: ['not-a-provider'] } },
      });
      expect(res.statusCode).toBe(400);
      expect(getProviderSpy.calls).toBe(0);
      expect(quotaUsed()).toBe(0);
    });
  }

  it('a voter list the plan does not include still gets the 403 first, not the 400', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan', headers: { ...headers, 'x-user-tier': 'pro' },
      payload: { text: TEXT, provider: 'mock', pipelineConfig: { consensus: true, consensusProviders: [] } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('consensus_not_in_plan');
  });

  it('consensus: false ignores the voter list (the scan is not a consensus scan)', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan', headers,
      payload: { text: TEXT, provider: 'mock', pipelineConfig: { consensus: false, consensusProviders: [] } },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('a consensus run with zero participating voters reports failure and uses no quota', () => {
  it('POST /scan: every named voter lacks an API key → 503 before any provider call', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan', headers,
      payload: { text: TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'mock', consensus: true, consensusProviders: ['openai', 'claude'] } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('consensus_unavailable');
    expect(getProviderSpy.calls).toBe(1); // the extraction provider is built; no voter is, and nothing is called
    expect(quotaUsed()).toBe(0);
    expect(spendRows()).toHaveLength(0);
  });

  it('POST /scan/stream: every named voter lacks an API key → error event, no complete, no quota', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan/stream', headers,
      payload: { text: TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'mock', consensus: true, consensusProviders: ['openai'] } },
    });
    expect(res.body).toContain('"error":"consensus_unavailable"');
    expect(res.body).not.toContain('"type":"complete"');
    expect(quotaUsed()).toBe(0);
  });

  it('POST /scan: every voter fails at run time → 502, not a 200 with degraded false', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key'; // the stubbed network answers OpenAI with a 500
    const res = await server.inject({
      method: 'POST', url: '/scan', headers,
      payload: { text: TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'mock', consensus: true, consensusProviders: ['openai'] } },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('consensus_unavailable');
    expect(quotaUsed()).toBe(0);
  });

  it('POST /scan/stream: every voter fails at run time → error event, no complete, no quota', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const res = await server.inject({
      method: 'POST', url: '/scan/stream', headers,
      payload: { text: TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'mock', consensus: true, consensusProviders: ['openai'] } },
    });
    expect(res.body).toContain('"error":"consensus_unavailable"');
    expect(res.body).not.toContain('"type":"complete"');
    expect(quotaUsed()).toBe(0);
  });

  it('a consensus scan with a voter that takes part is served and counted', async () => {
    const res = await server.inject({
      method: 'POST', url: '/scan', headers,
      payload: { text: TEXT, provider: 'mock', pipelineConfig: { extractionProvider: 'mock', consensus: true, consensusProviders: ['mock'] } },
    });
    expect(res.statusCode).toBe(200);
    const verdicts = Object.values(res.json().verifications as Record<string, { consensus?: { providerCount: number } }>);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((v) => v.consensus?.providerCount === 1)).toBe(true);
    expect(res.json().degraded).toBe(false);
    expect(quotaUsed()).toBe(1);
  });
});
