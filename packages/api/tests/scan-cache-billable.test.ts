// Validates: billing rule, a claim is billable only on sources the engine retrieved (POST /scan cache)
/**
 * The JSON /scan cache stores the whole scan result (store/cache.ts) and a hit
 * serves it back as stored (routes/scan.ts). So the billing rule reads the same
 * verdict on a hit as on the miss that stored it: a cached verdict that keeps
 * the engine's provenance.retriever is billable, and one stored without a
 * retriever is not.
 *
 * The miss writes the spend row and the cost-log row (scanWithSpend). A hit is
 * served without calling a provider and writes neither row today; these tests
 * pin that too, so a hit can never bill more than the miss counted.
 *
 * The cache refuses Gemini grounded results, so the billable side is a
 * consensus-shaped result whose retriever is 'openai-web-search'. The engine's
 * scan() is mocked to return it with one priced usage leg; route, cache, spend
 * ledger and cost store are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordUsage } from '@nxtg/faultline/lib/usage-sink.js';
import { billableVerdictCount, isBillableVerdict } from '@nxtg/faultline/lib/verdict-guard.js';

const fixture = vi.hoisted(() => ({ withRetriever: true, scanCalls: 0 }));

const TEXT = 'The Eiffel Tower was completed in 1889.';

/** The verdict a consensus scan gives, with or without the engine's retriever. */
function consensusVerdict(claimId: string, withRetriever: boolean): Record<string, unknown> {
  return {
    claimId,
    status: 'supported',
    explanation: 'ok',
    sources: [{ title: 'p', uri: 'https://publisher.example/a' }],
    provenance: {
      provider: 'consensus',
      model: 'openai:gpt-4o-mini+claude:claude-test',
      verifiedAt: '2026-10-01T00:00:00.000Z',
      ...(withRetriever ? { retriever: 'openai-web-search', retrievedAt: '2026-10-01T00:00:00.000Z' } : {}),
    },
  };
}

vi.mock('@nxtg/faultline/cli/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/cli/scan.js')>();
  return {
    ...actual,
    // A whole scan result from the real engine on the mock provider, with its
    // one verdict replaced by a consensus-shaped one.
    scan: vi.fn(async (text: string) => {
      fixture.scanCalls += 1;
      const result = await actual.scan(text, 'mock');
      recordUsage({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1000, outputTokens: 200, isGrounding: false });
      const ids = Object.keys(result.verifications);
      expect(ids).toEqual(['c1']);
      return { ...result, verifications: { c1: consensusVerdict('c1', fixture.withRetriever) } };
    }),
  };
});

import { buildServer } from '../src/server.js';
import { resetKeyStore, getKeyStore } from '../src/store/keys.js';
import { resetRateLimiter } from '../src/store/ratelimit.js';
import { resetUsageMeter } from '../src/store/usage.js';
import { resetCache, getScanCache } from '../src/store/cache.js';
import { resetProviderSpendLedger } from '../src/store/provider-spend.js';
import { getCostStore, resetCostStore, scanCostLogRow } from '../src/store/costs.js';
import { resetGroundingAllowanceLedger } from '../src/store/grounding-allowance.js';

const ENV_KEYS = ['FAULTLINE_GROUNDING_LEDGER', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP', 'OPENAI_API_KEY', 'FAULTLINE_CONSENSUS'];

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let spendLedger: string;
let server: FastifyInstance;
let key: string;

function spendRows(): Array<Record<string, unknown>> {
  if (!existsSync(spendLedger)) return [];
  return readFileSync(spendLedger, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function costRows(): Array<Record<string, unknown>> {
  return getCostStore().getManagedEvents(1).map((event) => JSON.parse(scanCostLogRow(event)));
}

async function post(): Promise<{ cache: unknown; body: Record<string, any> }> {
  const res = await server.inject({
    method: 'POST',
    url: '/scan',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    payload: { text: TEXT, provider: 'openai' },
  });
  expect(res.statusCode).toBe(200);
  return { cache: res.headers['x-cache'], body: res.json() };
}

/** Miss then hit; returns the hit body and the rows each request left. */
async function missThenHit() {
  const miss = await post();
  expect(miss.cache).toBe('MISS');
  expect(getScanCache().stats().size).toBe(1);
  const afterMiss = { spend: spendRows(), cost: costRows() };
  const hit = await post();
  expect(hit.cache).toBe('HIT');
  expect(hit.body.cache.hit).toBe(true);
  expect(fixture.scanCalls).toBe(1);
  return { miss, hit, afterMiss, afterHit: { spend: spendRows(), cost: costRows() } };
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.FAULTLINE_CONSENSUS;
  delete process.env.FAULTLINE_PROVIDER_SPEND_CAP;
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-cache-billable-'));
  spendLedger = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_GROUNDING_LEDGER = join(tmpDir, 'grounding-prompts.jsonl');
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = spendLedger;
  process.env.OPENAI_API_KEY = 'test-openai';
  fixture.withRetriever = true;
  fixture.scanCalls = 0;
  resetGroundingAllowanceLedger();
  resetProviderSpendLedger();
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  resetCostStore();
  key = getKeyStore().create('cache-billable', ['pro', 'scan']).key;
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

describe('POST /scan cache hit: billable on the stored verdict', () => {
  it('a hit whose verdict keeps provenance.retriever is billable', async () => {
    const { hit, afterMiss, afterHit } = await missThenHit();
    const v = hit.body.verifications.c1;
    expect(v.provenance.retriever).toBe('openai-web-search');
    expect(v.sources).toHaveLength(1);
    expect(isBillableVerdict(v)).toBe(true);
    expect(billableVerdictCount(hit.body.verifications)).toBe(1);
    // The miss that stored it counted the same verdict on both rows.
    expect(afterMiss.spend).toHaveLength(1);
    expect(afterMiss.spend[0]).toMatchObject({ verifiedCount: 1 });
    expect(afterMiss.cost).toHaveLength(1);
    expect(afterMiss.cost[0]).toMatchObject({ scan_id: afterMiss.spend[0].scanId, verified_count: 1 });
    // The hit itself writes no spend row and no cost-log row.
    expect(afterHit.spend).toEqual(afterMiss.spend);
    expect(afterHit.cost).toEqual(afterMiss.cost);
  });

  it('a hit whose stored verdict has no retriever is not billable', async () => {
    fixture.withRetriever = false;
    const { hit, afterMiss, afterHit } = await missThenHit();
    const v = hit.body.verifications.c1;
    // Same status and source as the billable side; only the retriever is missing.
    expect(v.status).toBe('supported');
    expect(v.sources).toHaveLength(1);
    expect(v.provenance.retriever).toBeUndefined();
    expect(isBillableVerdict(v)).toBe(false);
    expect(billableVerdictCount(hit.body.verifications)).toBe(0);
    expect(afterMiss.spend).toHaveLength(1);
    expect(afterMiss.spend[0]).toMatchObject({ verifiedCount: 0 });
    expect(afterMiss.cost).toHaveLength(1);
    expect(afterMiss.cost[0]).toMatchObject({ verified_count: 0 });
    expect(afterHit.spend).toEqual(afterMiss.spend);
    expect(afterHit.cost).toEqual(afterMiss.cost);
  });
});
