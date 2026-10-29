// Validates: billing rule, a claim is billable only on sources the engine retrieved (POST /admin/verify-claims)
/**
 * POST /admin/verify-claims calls a provider's verifyClaim directly, outside
 * the verify runner. It binds provenance with the runner's rule: the retriever
 * comes from the engine's table, only for the built-in instance of the provider
 * id the route resolved, and a retriever the provider set on itself is dropped.
 * So a provider that labels its own citations 'gemini-grounding' is not billed
 * unless it is the built-in provider the engine's table names.
 *
 * The registry is mocked: every provider id resolves to a fixture that cites
 * one source, reports one priced usage leg, and (when asked) sets its own
 * provenance. Under a built-in id the fixture stands in for that built-in's
 * instance unless `fixture.builtIn` is false. No network call and no real
 * provider is reachable from this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim, VerificationResult } from '@nxtg/faultline/types.js';
import { recordUsage } from '@nxtg/faultline/lib/usage-sink.js';

const fixture = vi.hoisted(() => ({ selfProvenance: true, builtIn: true }));

const SOURCE = { title: 'S', uri: 'https://example.org/s' };

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  // Test-only: a fixture resolved under a built-in id stands in for that
  // built-in's own instance, which the real registry records for its factories.
  const standIns = new WeakMap<object, string>();
  const standIn = <T,>(name: string | undefined, p: T): T => {
    if (fixture.builtIn && name !== undefined && actual.isBuiltInProviderName(name) && p && typeof p === 'object') standIns.set(p, name);
    return p;
  };
  return {
    ...actual,
    builtInProviderIdOf: vi.fn((p: unknown) => (p && typeof p === 'object' ? standIns.get(p) : undefined) ?? actual.builtInProviderIdOf(p)),
    getProvider: vi.fn((_key: string, name?: string) => standIn(name, {
      name: 'Self-labelling fixture',
      modelId: 'fixture-v1',
      extractClaims: vi.fn(),
      verifyClaim: async (claim: Claim): Promise<VerificationResult> => {
        recordUsage({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 200, isGrounding: false });
        return {
          claimId: claim.id,
          status: 'supported',
          explanation: 'ok',
          sources: [SOURCE],
          ...(fixture.selfProvenance
            ? { provenance: { provider: 'gemini', model: 'self-v1', verifiedAt: '2020-01-01T00:00:00.000Z', retriever: 'gemini-grounding', retrievedAt: '2020-01-01T00:00:00.000Z' } }
            : {}),
        };
      },
      generateCritiqueAndPrompt: vi.fn(),
    })),
  };
});

import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { getCostStore, scanCostLogRow } from '../src/store/costs.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { resetGroundingAllowanceLedger } from '../src/store/grounding-allowance.js';

const ADMIN_KEY = 'test-admin-key-engine-retriever';
const ENV_KEYS = [
  'FAULTLINE_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'FAULTLINE_GROUNDING_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_LEDGER',
  'FAULTLINE_PROVIDER_SPEND_CAP',
  'FAULTLINE_PROVIDER_SPEND_CAP_USD',
];

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let spendLedger: string;
let server: FastifyInstance;

const CLAIMS = [{ id: 'a', text: 'The Eiffel Tower is in Paris.' }, { id: 'b', text: 'Water boils at 100 C at sea level.' }];

function post(provider: string) {
  return server.inject({
    method: 'POST',
    url: '/admin/verify-claims',
    headers: { 'content-type': 'application/json', 'x-api-key': ADMIN_KEY },
    payload: { claims: CLAIMS, provider },
  });
}

function spendRows(): Array<Record<string, unknown>> {
  if (!existsSync(spendLedger)) return [];
  return readFileSync(spendLedger, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/** The batch's verified count on the spend row and on the cost-log row. */
function billedCounts(): { spend: unknown; costLog: unknown } {
  const rows = spendRows();
  expect(rows).toHaveLength(1);
  const events = getCostStore().getManagedEvents();
  expect(events).toHaveLength(1);
  const costRow = JSON.parse(scanCostLogRow(events[0]));
  expect(costRow).toMatchObject({ scan_id: rows[0].scanId, kind: 'admin-verify', claim_count: CLAIMS.length });
  return { spend: rows[0].verifiedCount, costLog: costRow.verified_count };
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-admin-verify-retriever-'));
  spendLedger = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_API_KEY = ADMIN_KEY;
  // Key resolution needs a value; the mocked registry never uses it.
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.OPENAI_API_KEY = 'test-openai';
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = spendLedger;
  fixture.selfProvenance = true;
  fixture.builtIn = true;
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetRateLimiter();
  getCostStore().reset();
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

describe('POST /admin/verify-claims bills only on the engine retriever', () => {
  it('a provider that sets its own retriever is not counted when the engine table does not name it', async () => {
    const res = await post('openai');
    expect(res.statusCode).toBe(200);
    // The verdict is reported as the provider returned it; only billing differs.
    const results = res.json().results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(['supported', 'supported']);
    expect(results.every((r) => r.apiError === false)).toBe(true);
    expect(billedCounts()).toEqual({ spend: 0, costLog: 0 });
  });

  it('a provider resolved as gemini that is not the built-in instance is not counted', async () => {
    fixture.builtIn = false;
    const res = await post('gemini');
    expect(res.statusCode).toBe(200);
    const results = res.json().results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(['supported', 'supported']);
    expect(billedCounts()).toEqual({ spend: 0, costLog: 0 });
  });

  it('the built-in gemini instance is counted: the engine table names gemini', async () => {
    const res = await post('gemini');
    expect(res.statusCode).toBe(200);
    expect((res.json().results as unknown[]).length).toBe(2);
    expect(billedCounts()).toEqual({ spend: 2, costLog: 2 });
  });

  it('a gemini verdict with no provenance of its own is counted: the engine binds the retriever', async () => {
    fixture.selfProvenance = false;
    const res = await post('gemini');
    expect(res.statusCode).toBe(200);
    expect(billedCounts()).toEqual({ spend: 2, costLog: 2 });
  });

  it('the route reports the same status, flags and model with or without a self-set retriever', async () => {
    const withOwn = (await post('openai')).json();
    fixture.selfProvenance = false;
    const without = (await post('openai')).json();
    const strip = (body: { results: Array<Record<string, unknown>> }) => body.results.map(({ usage: _u, ...rest }) => rest);
    expect(strip(withOwn)).toHaveLength(2);
    expect(strip(withOwn)).toEqual(strip(without));
  });
});
