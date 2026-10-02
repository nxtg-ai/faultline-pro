// Validates: prereg G0 §6 (docs/research/2026-10-02-prereg-verdict-accuracy-g0-v1.md): admin verify-only route
/**
 * POST /admin/verify-claims — the verify step alone, for the verdict-accuracy run.
 *
 * The Gemini SDK is mocked at the module boundary (the codebase convention), so
 * the REAL path runs underneath: registry → gemini provider → geminiService
 * .verifyClaim → recordUsage → the route's captureUsage → buildManagedCostEvent →
 * provider-spend ledger, and the process-wide observer → grounding-allowance
 * ledger. No network call and no real provider is reachable from this file.
 *
 * Sentinels in the mocked grounded reply (explanation and source title) let the
 * tests prove that no grounded text reaches the wire (Google grounding terms).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sdk = vi.hoisted(() => ({ calls: 0, inFlight: 0, maxInFlight: 0 }));

const EXPLANATION_SENTINEL = 'GROUNDED-EXPLANATION-SENTINEL';
const SOURCE_SENTINEL = 'SOURCE-TITLE-SENTINEL';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (params: { contents: unknown }) => {
        sdk.calls += 1;
        sdk.inFlight += 1;
        sdk.maxInFlight = Math.max(sdk.maxInFlight, sdk.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        sdk.inFlight -= 1;
        const prompt = String(params.contents);
        if (prompt.includes('THROW-ME')) throw new Error('503 model overloaded');
        const grounded = {
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
          candidates: [{
            groundingMetadata: {
              groundingChunks: [{ web: { title: SOURCE_SENTINEL, uri: 'https://example.com/sentinel' } }],
            },
          }],
        };
        if (prompt.includes('NOT-JSON')) {
          return { ...grounded, text: `The evidence is thin. ${EXPLANATION_SENTINEL}` };
        }
        const status = prompt.includes('FALSE-CLAIM') ? 'contradicted' : 'supported';
        return { ...grounded, text: JSON.stringify({ status, explanation: EXPLANATION_SENTINEL }) };
      },
    };
  },
}));

import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { getCostStore, buildManagedCostEvent } from '../src/store/costs.js';
import { recordProviderSpend, resetProviderSpendLedger } from '../src/store/provider-spend.js';
import {
  getGroundingAllowanceStatus,
  resetGroundingAllowanceLedger,
} from '../src/store/grounding-allowance.js';

const ADMIN_KEY = 'test-admin-key-verify-claims';
const ENV_KEYS = [
  'FAULTLINE_API_KEY',
  'GEMINI_API_KEY',
  'FAULTLINE_GROUNDING_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_PROVIDER_SPEND_CAP_USD',
];

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let spendLedger: string;
let server: FastifyInstance;

type ClaimInput = { id: string; text: string };

function claims(n: number, text = 'The Eiffel Tower is in Paris.'): ClaimInput[] {
  return Array.from({ length: n }, (_, i) => ({ id: String(i), text }));
}

/** `key: null` sends no x-api-key header at all. */
function post(payload: unknown, key: string | null = ADMIN_KEY) {
  return server.inject({
    method: 'POST',
    url: '/admin/verify-claims',
    headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'x-api-key': key }) },
    payload: payload as Record<string, unknown>,
  });
}

function spendRows(): Array<Record<string, unknown>> {
  if (!existsSync(spendLedger)) return [];
  return readFileSync(spendLedger, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every object key anywhere in a JSON value. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

beforeEach(async () => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-admin-verify-'));
  spendLedger = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_API_KEY = ADMIN_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = spendLedger;
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetRateLimiter();
  getCostStore().reset();
  sdk.calls = 0;
  sdk.inFlight = 0;
  sdk.maxInFlight = 0;
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /admin/verify-claims — access (requireAdmin)', () => {
  it('refuses a request with no key (403) and never calls the provider', async () => {
    const res = await post({ claims: claims(1) }, null);
    expect(res.statusCode).toBe(403);
    expect(sdk.calls).toBe(0);
  });

  it('refuses a valid non-admin key (403) and never calls the provider', async () => {
    const key = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await post({ claims: claims(1) }, key.key);
    expect(res.statusCode).toBe(403);
    expect(sdk.calls).toBe(0);
  });

  it('refuses a wrong key (403)', async () => {
    const res = await post({ claims: claims(1) }, 'not-the-admin-key');
    expect(res.statusCode).toBe(403);
    expect(sdk.calls).toBe(0);
  });

  it('accepts a keystore key holding the admin permission', async () => {
    const key = getKeyStore().create('Ops', ['admin']);
    const res = await post({ claims: claims(1) }, key.key);
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /admin/verify-claims — body validation', () => {
  it('rejects more than 25 claims with 400 before any provider call', async () => {
    const res = await post({ claims: claims(26) });
    expect(res.statusCode).toBe(400);
    expect(sdk.calls).toBe(0);
  });

  it('accepts exactly 25 claims', async () => {
    const res = await post({ claims: claims(25) });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(25);
  });

  it('rejects a missing or empty claim list, a claim over 2,000 chars, a missing id or text, and an unknown provider', async () => {
    const bodies = [
      {},
      { claims: [] },
      { claims: [{ id: '0', text: 'x'.repeat(2001) }] },
      { claims: [{ id: '0', text: '' }] },
      { claims: [{ text: 'no id' }] },
      { claims: [{ id: '0' }] },
      { claims: claims(1), provider: 'not-a-provider' },
    ];
    for (const body of bodies) {
      const res = await post(body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(sdk.calls).toBe(0);
  });

  it('drops unknown fields (Fastify removeAdditional, as on /scan): consensus cannot be switched on', async () => {
    const res = await post({
      claims: [{ id: '0', text: 'ok', explanation: 'caller text' }],
      pipelineConfig: { consensus: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toBe('gemini');
    expect(res.body).not.toContain('caller text');
    expect(sdk.calls).toBe(1);
  });

  it('accepts a claim of exactly 2,000 chars', async () => {
    const res = await post({ claims: [{ id: '0', text: 'x'.repeat(2000) }] });
    expect(res.statusCode).toBe(200);
  });

  it('rejects duplicate claim ids with 400 before any provider call', async () => {
    const res = await post({ claims: [{ id: '7', text: 'a' }, { id: '7', text: 'b' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('duplicate_claim_id');
    expect(sdk.calls).toBe(0);
  });

  it('answers 503 provider_not_configured when the provider key is missing, without calling it', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await post({ claims: claims(1) });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'provider_not_configured', provider: 'gemini' });
    expect(sdk.calls).toBe(0);
  });
});

describe('POST /admin/verify-claims — verdicts, flags, and nothing grounded on the wire', () => {
  it('defaults to the production provider (gemini) and returns one row per claim in order', async () => {
    const res = await post({
      claims: [
        { id: '10', text: 'A FALSE-CLAIM about the moon.' },
        { id: '11', text: 'Water boils at 100 C at sea level.' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('gemini');
    expect(body.results).toEqual([
      { id: '10', status: 'contradicted', apiError: false, parseFallback: false, model: 'gemini-2.5-flash' },
      { id: '11', status: 'supported', apiError: false, parseFallback: false, model: 'gemini-2.5-flash' },
    ]);
    expect(sdk.calls).toBe(2);
  });

  it('flags a non-JSON model reply as parseFallback with status mixed', async () => {
    const res = await post({ claims: [{ id: '3', text: 'NOT-JSON reply please.' }] });
    expect(res.json().results[0]).toEqual({
      id: '3', status: 'mixed', apiError: false, parseFallback: true, model: 'gemini-2.5-flash',
    });
  });

  it('reports a provider failure as apiError, never as a verdict', async () => {
    const res = await post({ claims: [{ id: '4', text: 'THROW-ME now.' }, { id: '5', text: 'Fine claim.' }] });
    const [failed, ok] = res.json().results;
    expect(failed).toEqual({ id: '4', status: 'unverified', apiError: true, parseFallback: false, model: null });
    expect(ok).toMatchObject({ id: '5', status: 'supported', apiError: false });
  });

  it('carries no explanation, sources or any grounded text anywhere in the response', async () => {
    const res = await post({ claims: [{ id: '1', text: 'Fine claim.' }, { id: '2', text: 'NOT-JSON reply.' }] });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(EXPLANATION_SENTINEL);
    expect(res.body).not.toContain(SOURCE_SENTINEL);
    expect(res.body).not.toContain('example.com');
    const keys = allKeys(res.json());
    expect(keys.size).toBeGreaterThan(0);
    for (const forbidden of ['explanation', 'sources', 'searchEntryPoint', 'groundingMetadata', 'claimId']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect([...keys].sort()).toEqual(['apiError', 'id', 'model', 'parseFallback', 'provider', 'results', 'status']);
  });

  it('keeps at most 4 claims in flight at once', async () => {
    const res = await post({ claims: claims(25) });
    expect(res.statusCode).toBe(200);
    expect(sdk.calls).toBe(25);
    expect(sdk.maxInFlight).toBe(4);
  });

  it('honours an explicit mock provider and reports its model', async () => {
    const res = await post({ claims: claims(2), provider: 'mock' });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { status: string; model: string }) => [r.status, r.model]))
      .toEqual([['supported', 'mock-v1'], ['supported', 'mock-v1']]);
    expect(sdk.calls).toBe(0);
  });
});

describe('POST /admin/verify-claims — the ledgers a scan writes', () => {
  it('counts one grounded prompt per answered claim on the daily grounding allowance', async () => {
    expect(getGroundingAllowanceStatus().groundedPrompts).toBe(0);
    const res = await post({ claims: [...claims(3), { id: 'x', text: 'THROW-ME' }] });
    expect(res.statusCode).toBe(200);
    // The failed call returned no response, so it is not a grounded prompt (N-230 rule).
    expect(getGroundingAllowanceStatus().groundedPrompts).toBe(3);
  });

  it('appends one priced provider-spend row for the batch, priced from the captured legs', async () => {
    expect(spendRows()).toHaveLength(0);
    const res = await post({ claims: claims(3) });
    expect(res.statusCode).toBe(200);

    const rows = spendRows();
    expect(rows).toHaveLength(1);
    const leg = {
      provider: 'gemini', model: 'gemini-2.5-flash', callType: 'grounded-verify:gemini',
      inputTokens: 100, outputTokens: 20, isGrounding: true,
    };
    const expected = buildManagedCostEvent([leg, leg, leg], {
      text: 'unused', provider: 'gemini', claimCount: 3, tier: 'enterprise', latencyMs: 0,
    });
    expect(expected.costUsd).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ provider: 'gemini', modelId: 'gemini-2.5-flash', tier: 'enterprise' });
    expect(rows[0].costUsd as number).toBeCloseTo(expected.costUsd, 10);
  });

  it('records the batch in the managed cost store, the same store a scan writes (mock provider)', async () => {
    expect(getCostStore().getManagedEvents()).toHaveLength(0);
    const res = await post({ claims: claims(2), provider: 'mock' });
    expect(res.statusCode).toBe(200);
    const events = getCostStore().getManagedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: 'mock', keyMode: 'managed' });
    // Mock prices at $0 and the spend ledger refuses $0 rows, as it does for a mock scan.
    expect(spendRows()).toHaveLength(0);
  });

  it('is refused by the provider-spend cap once the budget is exhausted, with no provider call', async () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '1';
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    recordProviderSpend({
      scanId: 'prior', ts: new Date().toISOString(), tier: 'pro', keyMode: 'managed',
      provider: 'gemini', modelId: 'gemini-2.5-flash', inputTokens: 1, outputTokens: 1,
      groundingCalls: 0, costUsd: 1.5, latencyMs: 1,
    });
    const res = await post({ claims: claims(1) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/provider budget exhausted/i);
    expect(sdk.calls).toBe(0);
    expect(spendRows()).toHaveLength(1);
    expect(getGroundingAllowanceStatus().groundedPrompts).toBe(0);
  });

  it('passes the burst rate limiter (sets X-RateLimit headers)', async () => {
    const res = await post({ claims: claims(1) });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});

describe('GET /health — engine commit', () => {
  it('reports the build commit when FAULTLINE_GIT_SHA is a hex sha, else null', async () => {
    const saved = process.env.FAULTLINE_GIT_SHA;
    try {
      delete process.env.FAULTLINE_GIT_SHA;
      expect((await server.inject({ method: 'GET', url: '/health' })).json().commit).toBeNull();
      process.env.FAULTLINE_GIT_SHA = '4de048a1b2c3d4e5f60718293a4b5c6d7e8f9012';
      expect((await server.inject({ method: 'GET', url: '/health' })).json().commit)
        .toBe('4de048a1b2c3d4e5f60718293a4b5c6d7e8f9012');
      process.env.FAULTLINE_GIT_SHA = '<script>';
      expect((await server.inject({ method: 'GET', url: '/health' })).json().commit).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.FAULTLINE_GIT_SHA;
      else process.env.FAULTLINE_GIT_SHA = saved;
    }
  });
});
