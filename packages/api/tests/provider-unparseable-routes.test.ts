/**
 * POST /scan reports an unreadable provider reply as an unchecked claim with
 * reason 'provider_unparseable' (emma-soul ruling al:5b18840b0116047a, item c):
 * never 'mixed', the scan is degraded, the claim is not counted as verified in
 * the cost log, and the scan is not cached. faultline-web bills a claim free when
 * it carries apiError (fw al:78275c292aa09eac), so this shape is the contract.
 *
 * Only the provider registry is mocked; the real engine scan() runs.
 */
// Validates: N-234 (billable unit, GoPMO 1.18.11.7.13)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Claim } from '@nxtg/faultline/types.js';
import { unparseableVerdict } from '@nxtg/faultline/providers/verdict-reply.js';
import { buildServer } from '../src/server.js';
import { resetKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { getCostStore, resetCostStore } from '../src/store/costs.js';
import { resetCircuitBreaker } from '../src/store/circuit-breaker.js';
import { resetCache } from '../src/store/cache.js';

const control = vi.hoisted(() => ({ verifyCalls: 0 }));
const CLAIMS = [
  { id: 'c1', text: 'The Eiffel Tower is in Paris.', type: 'fact', importance: 4 },
  { id: 'c2', text: 'It opened in 1889.', type: 'fact', importance: 3 },
];

vi.mock('@nxtg/faultline/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/providers/registry.js')>();
  // Test-only: a fixture resolved under a built-in id stands in for that
  // built-in's own instance, which the real registry records for its factories.
  const standIns = new WeakMap<object, string>();
  const standIn = <T,>(name: string | undefined, p: T): T => {
    if (name !== undefined && actual.isBuiltInProviderName(name) && p && typeof p === 'object') standIns.set(p, name);
    return p;
  };
  return {
    ...actual,
    builtInProviderIdOf: vi.fn((p: unknown) => (p && typeof p === 'object' ? standIns.get(p) : undefined) ?? actual.builtInProviderIdOf(p)),
    getProvider: vi.fn((_key: string, name?: string) => standIn(name, {
      name: 'Unparseable Fixture',
      modelId: 'fixture-v1',
      extractClaims: async () => CLAIMS,
      verifyClaim: async (claim: Claim) => {
        control.verifyCalls += 1;
        return claim.id === 'c1'
          ? unparseableVerdict(claim.id)
          : { claimId: claim.id, status: 'supported', explanation: 'ok', sources: [{ title: 'p', uri: 'https://publisher.example/a' }] };
      },
      generateCritiqueAndPrompt: vi.fn(),
    })),
  };
});

const SERVER_KEY = 'test-unparseable-server-key';
const ENV_KEYS = ['FAULTLINE_API_KEY', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP', 'GEMINI_API_KEY'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let server: FastifyInstance;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'unparseable-'));
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  delete process.env.FAULTLINE_PROVIDER_SPEND_CAP;
  process.env.GEMINI_API_KEY = 'fixture-key';
  control.verifyCalls = 0;
  resetKeyStore(); resetRateLimiter(); resetUsageMeter(); resetCostStore();
  resetProviderSpendLedger(); resetCircuitBreaker(); resetCache();
  server = buildServer();
  await server.ready();
});

afterEach(async () => {
  await server.close();
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

describe('POST /scan with an unreadable provider reply', () => {
  it('reports the claim unchecked with reason provider_unparseable, never mixed, and the scan degraded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await scan();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const c1 = body.verifications.c1;
    expect(c1.status).not.toBe('mixed');
    expect(c1).toMatchObject({ status: 'unverified', apiError: true, apiErrorReason: 'provider_unparseable' });
    expect(body.verifications.c2).toMatchObject({ status: 'supported' });
    expect(body.verifications.c2.apiError).toBeUndefined();
    expect(body.degraded).toBe(true);
  });

  it('counts only the readable verdict as verified in the cost log, and does not cache the scan', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await scan();
    const events = getCostStore().getManagedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ claimsExtracted: 2, claimsVerified: 1 });
    expect(control.verifyCalls).toBe(2);
    await scan();
    expect(control.verifyCalls).toBe(4);
  });
});
