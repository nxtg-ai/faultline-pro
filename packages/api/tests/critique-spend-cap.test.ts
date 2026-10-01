// Validates: N-230 (provider-spend cap covers /critique)
/**
 * POST /critique makes a paid LLM call on our env-configured provider keys, so
 * the fleet provider-spend cap (A-110 item 1) must gate it and its cost must land
 * in the append-only ledger, exactly as /scan and /scan/stream do.
 *
 * The registry is mocked so the provider is a spy. The spending fake reports
 * usage through the REAL `recordUsage` seam (the one the OpenAI adapter calls),
 * so the route's real captureUsage -> buildManagedCostEvent -> ledger path prices
 * it. The stock mock provider reports no usage and prices at $0, which the ledger
 * correctly refuses to record, so it cannot prove a row is written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { recordUsage } from '@nxtg/faultline/lib/usage-sink.js';
import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import {
  recordProviderSpend,
  resetProviderSpendLedger,
} from '../src/store/provider-spend.js';

const providerSpy = vi.hoisted(() => ({
  generateCritiqueAndPrompt: vi.fn(),
}));

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      name: 'Spy Provider',
      modelId: 'gpt-4o-mini',
      extractClaims: vi.fn(),
      verifyClaim: vi.fn(),
      generateCritiqueAndPrompt: providerSpy.generateCritiqueAndPrompt,
    })),
  };
});
vi.mock('@nxtg/faultline/cli/scan.js', () => ({ scan: vi.fn() }));
vi.mock('@nxtg/faultline/cli/extract.js', () => ({ extractTextFromBuffer: vi.fn() }));

const SPEND_ENV_KEYS = [
  'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_PROVIDER_SPEND_CAP_USD',
  'FAULTLINE_PROVIDER_SPEND_LEDGER',
];

// gpt-4o-mini at $0.15/M in, $0.60/M out -> 1000 in + 200 out = $0.00027.
const INPUT_TOKENS = 1000;
const OUTPUT_TOKENS = 200;
const EXPECTED_COST_USD = (INPUT_TOKENS / 1_000_000) * 0.15 + (OUTPUT_TOKENS / 1_000_000) * 0.60;

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let tmpLedger: string;
let server: FastifyInstance;

function makeClaim(id: string): Claim {
  return { id, text: `Claim ${id}`, type: 'fact', importance: 3 };
}

function makeVerification(claimId: string, status: VerificationResult['status']): VerificationResult {
  return { claimId, status, explanation: 'test', sources: [] };
}

/** A provider call that bills: reports real usage through the production seam. */
function spendingCritique(): void {
  providerSpy.generateCritiqueAndPrompt.mockImplementation(async () => {
    recordUsage({
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: INPUT_TOKENS,
      outputTokens: OUTPUT_TOKENS,
      isGrounding: false,
    });
    return { critique: 'Fractured.', improvedPrompt: 'Cite sources.' };
  });
}

function ledgerRows(): Array<Record<string, unknown>> {
  if (!existsSync(tmpLedger)) return [];
  return readFileSync(tmpLedger, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function postCritique(apiKey: string, failed: boolean) {
  const claims = [makeClaim('c1'), makeClaim('c2')];
  const verifications: Record<string, VerificationResult> = {
    c1: makeVerification('c1', 'supported'),
    c2: makeVerification('c2', failed ? 'contradicted' : 'supported'),
  };
  return server.inject({
    method: 'POST',
    url: '/critique',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    payload: { claims, verifications, text: 'Some AI-generated text.', provider: 'openai' },
  });
}

beforeEach(async () => {
  savedEnv = {};
  for (const k of SPEND_ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of SPEND_ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-critique-spend-'));
  tmpLedger = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = tmpLedger;
  resetProviderSpendLedger();
  resetKeyStore();
  resetRateLimiter();
  providerSpy.generateCritiqueAndPrompt.mockReset();
  spendingCritique();
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
  for (const k of SPEND_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetProviderSpendLedger();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /critique — provider-spend cap (N-230)', () => {
  it('refuses with 503 once the monthly budget is exhausted, and never calls the provider', async () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '1';
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    recordProviderSpend({
      scanId: 'prior-scan', ts: new Date().toISOString(), tier: 'pro', keyMode: 'managed',
      provider: 'openai', modelId: 'gpt-4o-mini', inputTokens: 1, outputTokens: 1,
      groundingCalls: 0, costUsd: 1.5, latencyMs: 1,
    });
    const rowsBefore = ledgerRows().length;
    expect(rowsBefore).toBe(1);

    const key = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await postCritique(key.key, true);

    expect(res.statusCode).toBe(503);
    expect(res.headers['x-provider-spend-cap']).toBe('1.00');
    expect(res.headers['x-provider-spend-used']).toBe('1.50');
    expect(res.json().error).toMatch(/provider budget exhausted/i);
    expect(providerSpy.generateCritiqueAndPrompt).not.toHaveBeenCalled();
    expect(ledgerRows()).toHaveLength(rowsBefore);
  });

  it('under the cap: returns 200 and appends exactly one priced ledger row', async () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP_USD = '100';
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    expect(ledgerRows()).toHaveLength(0);

    const key = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await postCritique(key.key, true);

    expect(res.statusCode).toBe(200);
    expect(res.json().critique).toBe('Fractured.');
    expect(providerSpy.generateCritiqueAndPrompt).toHaveBeenCalledTimes(1);
    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'openai', modelId: 'gpt-4o-mini', tier: 'pro' });
    expect(rows[0].costUsd as number).toBeCloseTo(EXPECTED_COST_USD, 10);
  });

  it('ledgers critique spend while the gate is DORMANT (ledger is always on)', async () => {
    const key = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await postCritique(key.key, true);

    expect(res.statusCode).toBe(200);
    expect(ledgerRows()).toHaveLength(1);
  });

  it('no failed claims: no LLM call and no ledger row', async () => {
    process.env.FAULTLINE_PROVIDER_SPEND_CAP = 'on';
    const key = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await postCritique(key.key, false);

    expect(res.statusCode).toBe(200);
    expect(res.json().hasCritique).toBe(false);
    expect(providerSpy.generateCritiqueAndPrompt).not.toHaveBeenCalled();
    expect(ledgerRows()).toHaveLength(0);
  });

  it('rejects a provider name outside the allowlist with 400 before any call', async () => {
    const key = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await server.inject({
      method: 'POST',
      url: '/critique',
      headers: { 'x-api-key': key.key, 'content-type': 'application/json' },
      payload: {
        claims: [makeClaim('c1')],
        verifications: { c1: makeVerification('c1', 'contradicted') },
        text: 'Some text.',
        provider: 'not-a-provider',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(providerSpy.generateCritiqueAndPrompt).not.toHaveBeenCalled();
    expect(ledgerRows()).toHaveLength(0);
  });

  it('applies the per-key burst rate limiter (sets X-RateLimit headers)', async () => {
    const key = getKeyStore().create('Pro Key', ['pro', 'scan']);
    const res = await postCritique(key.key, false);

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});
