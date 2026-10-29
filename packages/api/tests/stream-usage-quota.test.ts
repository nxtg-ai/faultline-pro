/**
 * /scan/stream counts a scan toward the monthly quota only when at least one
 * claim got a verdict that is not an API error. A scan where every claim failed
 * at the provider checked nothing, so it costs the customer no scan.
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

type Outcome = 'error' | 'unverified' | 'mixed-errors';
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

const ENV_KEYS = ['FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_EVIDENCE_FETCH', 'FAULTLINE_CONSENSUS'];
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-stream-quota-'));
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_EVIDENCE_FETCH = 'off';
  delete process.env.FAULTLINE_CONSENSUS;
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
    const res = method === 'POST'
      ? await server.inject({
        method: 'POST', url: '/scan/stream',
        headers: { 'x-api-key': entry.key, 'content-type': 'application/json' },
        payload: JSON.stringify({ text, provider: 'mock' }),
      })
      : await server.inject({
        method: 'GET', url: `/scan/stream?provider=mock&text=${encodeURIComponent(text)}`,
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

  it('one claim checked (inconclusive), one an API error: the scan is counted once', async () => {
    const { count, verdicts } = await runStream(method, 'mixed-errors');
    expect(verdicts).toBe(2);
    expect(count).toBe(1);
  });

  it('every claim checked and inconclusive: the scan is counted once', async () => {
    const { count, verdicts } = await runStream(method, 'unverified');
    expect(verdicts).toBe(2);
    expect(count).toBe(1);
  });
});
