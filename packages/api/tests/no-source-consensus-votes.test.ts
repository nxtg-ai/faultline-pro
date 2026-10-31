// Validates: no definite verdict without a source, on every provider and path (consensus votes included)
/**
 * A consensus result lists every provider's vote, and a reader sees each one.
 * A vote that says supported with only an ftp: or javascript: citation must
 * read unverified with no source, on a fresh POST /scan and POST /scan/stream,
 * exactly as the fused verdict does. A vote with one openable source keeps its
 * status and only that source. The rewrite is for the reader only: the fused
 * verdict and the billed counts are the same as with the vote rewrite left out.
 *
 * Local fixtures only: fetch is stubbed (no network) and every key is a dummy.
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

// When set, abstainWithoutSource leaves votes as given (the vote rewrite disabled), for comparison.
const toggle = vi.hoisted(() => ({ disableVoteRewrite: false }));

vi.mock('@nxtg/faultline/lib/verdict-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nxtg/faultline/lib/verdict-guard.js')>();
  return {
    ...actual,
    abstainWithoutSource: <T extends { providerVotes?: unknown }>(r: T): T => {
      if (!toggle.disableVoteRewrite || !r || typeof r !== 'object' || !('providerVotes' in r)) return actual.abstainWithoutSource(r as never) as T;
      const guarded = actual.abstainWithoutSource({ ...r, providerVotes: undefined } as never) as T;
      return { ...guarded, providerVotes: r.providerVotes };
    },
  };
});

const NO_SOURCE_EXPLANATION =
  'The search returned no source this claim can be checked against, so it is not marked supported, contradicted or mixed.';
const SERVER_KEY = 'no-source-consensus-votes-server-key';
const TEXT = 'Paris is in France.';
const headers = { 'x-api-key': SERVER_KEY, 'content-type': 'application/json' };
const payload = {
  text: TEXT,
  provider: 'mock',
  pipelineConfig: { extractionProvider: 'mock', consensus: true, consensusProviders: ['openai'] },
};
const ENV_KEYS = ['FAULTLINE_API_KEY', 'FAULTLINE_PROVIDER_SPEND_LEDGER', 'FAULTLINE_PROVIDER_SPEND_CAP', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY'];

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;
let spendLedger: string;
let server: FastifyInstance;
/** The citation urls the stubbed OpenAI web search returns. */
let citations: string[];

function stubNetwork(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const target = String(url);
    if (target === 'https://api.openai.com/v1/responses') {
      const text = 'Paris is the capital of France.';
      return new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: citations.map((u) => ({ type: 'url_citation', url: u, title: 'Fact', start_index: 0, end_index: text.length })) }] }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.startsWith('https://api.openai.com/v1/chat/completions')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ status: 'supported', explanation: 'Model says supported.' }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('unavailable in tests', { status: 500 });
  }));
}

function spendRows(): Array<Record<string, unknown>> {
  if (!existsSync(spendLedger)) return [];
  return readFileSync(spendLedger, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function parseSSE(body: string): Array<Record<string, unknown>> {
  return body.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)) as Record<string, unknown>);
}

type Verdict = Record<string, unknown> & { providerVotes?: Array<Record<string, unknown>> };

/** The verdicts a reader is served, and what was billed, for one request. */
async function run(url: '/scan' | '/scan/stream'): Promise<{ verdicts: Verdict[]; quota: number; billed: unknown[] }> {
  const res = await server.inject({ method: 'POST', url, headers, payload });
  expect(res.statusCode).toBe(200);
  let verdicts: Verdict[];
  if (url === '/scan') {
    verdicts = Object.values(res.json().verifications as Record<string, Verdict>);
  } else {
    const events = parseSSE(res.body);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
    verdicts = events.filter((e) => e.type === 'claim_verified').map((e) => e.verdict as Verdict);
  }
  expect(verdicts.length).toBe(1);
  return {
    verdicts,
    quota: getUsageMeter().getMonthlyCount('admin'),
    billed: spendRows().map((r) => r.verifiedCount),
  };
}

/** The fused part of a verdict (everything but the votes and the timestamps). */
function fused(v: Verdict): Record<string, unknown> {
  const { providerVotes: _votes, provenance, ...rest } = v;
  const p = provenance as Record<string, unknown> | undefined;
  return { ...rest, retriever: p?.retriever };
}

function resetStores(): void {
  resetKeyStore();
  resetRateLimiter();
  resetUsageMeter();
  resetCache();
  resetCircuitBreaker();
  resetCostStore();
  resetProviderSpendLedger();
  rmSync(spendLedger, { force: true });
}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = mkdtempSync(join(tmpdir(), 'fl-consensus-votes-'));
  spendLedger = join(tmpDir, 'provider-spend.jsonl');
  process.env.FAULTLINE_API_KEY = SERVER_KEY;
  process.env.FAULTLINE_PROVIDER_SPEND_LEDGER = spendLedger;
  process.env.OPENAI_API_KEY = 'dummy-openai-key';
  delete process.env.FAULTLINE_PROVIDER_SPEND_CAP;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  toggle.disableVoteRewrite = false;
  stubNetwork();
  resetStores();
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
  toggle.disableVoteRewrite = false;
  resetProviderSpendLedger();
  resetKeyStore();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Run once with the vote rewrite disabled, then once as served, from clean stores. */
async function both(url: '/scan' | '/scan/stream') {
  toggle.disableVoteRewrite = true;
  const without = await run(url);
  toggle.disableVoteRewrite = false;
  resetStores();
  const served = await run(url);
  expect(fused(served.verdicts[0])).toEqual(fused(without.verdicts[0]));
  expect(served.quota).toBe(without.quota);
  expect(served.billed).toEqual(without.billed);
  return { served: served.verdicts[0], without: without.verdicts[0] };
}

for (const url of ['/scan', '/scan/stream'] as const) {
  describe(`POST ${url} with consensus on: each vote follows the source rule`, () => {
    for (const only of ['ftp://source.example/fact', 'javascript:alert(1)']) {
      it(`a supported vote whose only source is ${only} reads unverified with no source`, async () => {
        citations = [only];
        const { served, without } = await both(url);
        // With the rewrite disabled the vote would show supported with the unopenable source.
        expect(without.providerVotes?.[0]).toMatchObject({ provider: 'openai', status: 'supported', sources: [{ uri: only }] });
        expect(served.status).toBe('unverified');
        expect(served.sources).toEqual([]);
        expect(served.providerVotes?.length).toBe(1);
        expect(served.providerVotes![0]).toEqual({
          provider: 'openai', status: 'unverified', sources: [], explanation: NO_SOURCE_EXPLANATION, noSourceAbstain: true,
        });
      });
    }

    it('a supported vote with one https and one ftp source stays supported with only the https source', async () => {
      citations = ['https://source.example/fact', 'ftp://source.example/fact'];
      const { served } = await both(url);
      expect(served.status).toBe('supported');
      expect((served.sources as Array<{ uri: string }>).map((s) => s.uri)).toEqual(['https://source.example/fact']);
      expect(served.providerVotes?.length).toBe(1);
      const vote = served.providerVotes![0];
      expect(vote.status).toBe('supported');
      expect((vote.sources as Array<{ uri: string }>).map((s) => s.uri)).toEqual(['https://source.example/fact']);
      expect(vote.explanation).toBe('Model says supported.');
      expect(vote.noSourceAbstain).toBeUndefined();
    });
  });
}
