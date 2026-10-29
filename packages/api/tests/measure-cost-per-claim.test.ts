/**
 * scripts/measure-cost-per-claim.mjs with a stubbed fetch: no network, no provider, no key on disk.
 *
 * The stub plays the admin API: GET /health, GET /usage (a provider-spend ledger that rises by the
 * cost of each verify request plus optional other traffic), and POST /admin/verify-claims (one result
 * per claim with per-claim usage). A sentinel in every claim's text proves no claim text reaches any
 * output.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CORPUS_PATH,
  EXIT,
  PROVIDERS,
  RESERVE_PER_CLAIM_USD,
  UsageError,
  loadCorpus,
  markdownPath,
  parseArgs,
  percentile,
  plan,
  renderMarkdown,
  run,
  subsample,
} from '../../../scripts/measure-cost-per-claim.mjs';
import { PROVIDER_ENUM, MAX_VERIFY_CLAIMS } from '../src/routes/admin-verify.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const KEY = ['cost', 'ADMINKEY', 'never-print'].join('-');
const TEXT_SENTINEL = 'CLAIM-TEXT-SENTINEL';
const CORPUS = Array.from({ length: 40 }, (_, i) => ({ id: String(i), text: `${TEXT_SENTINEL} number ${i}` }));

interface StubOptions {
  /** USD per claim the route reports, by provider. */
  costPerClaim?: Record<string, number>;
  /** Extra ledger spend per request from other traffic. */
  otherTrafficUsd?: number;
  /** HTTP status and body to answer a provider's verify request with. */
  failWith?: Record<string, { status: number; body: unknown }>;
}

interface Request { method: string; route: string; body: { provider: string; claims: Array<{ id: string; text: string }> } | null; key: string | null }

function stubApi(opts: StubOptions = {}) {
  let spent = 12.5; // spend already on the ledger before the run
  const requests: Request[] = [];
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method: init.method, route, body, key: init.headers['x-api-key'] ?? null });
    const reply = (status: number, json: unknown) => ({ status, ok: status < 400, json: async () => json });
    if (route === '/health') return reply(200, { status: 'ok', version: '0.11.1', commit: 'abc123' });
    if (route === '/usage') return reply(200, { providerBudget: { spentUsd: spent, enforced: true } });
    if (route === '/admin/verify-claims') {
      const fail = opts.failWith?.[body.provider];
      if (fail) return reply(fail.status, fail.body);
      const cost = opts.costPerClaim?.[body.provider] ?? 0.01;
      spent += cost * body.claims.length + (opts.otherTrafficUsd ?? 0);
      return reply(200, {
        provider: body.provider,
        results: body.claims.map((c: { id: string }, i: number) => ({
          id: c.id,
          status: i % 3 === 0 ? 'contradicted' : 'supported',
          apiError: false,
          parseFallback: false,
          noSourceAbstain: false,
          apiErrorReason: null,
          model: `${body.provider}-model`,
          usage: { inputTokens: 100, outputTokens: 20, groundingCalls: 1, costUsd: cost, priced: true },
        })),
      });
    }
    return reply(404, { error: 'not_found' });
  };
  return { fetch, requests, posts: () => requests.filter((r) => r.method === 'POST') };
}

function deps(stub: ReturnType<typeof stubApi>, files: Map<string, string> = new Map()) {
  let clock = Date.parse('2026-10-26T00:00:00Z');
  return {
    fetch: stub.fetch,
    key: KEY,
    corpus: CORPUS,
    sleep: async () => {},
    now: () => (clock += 40),
    log: () => {},
    write: (file: string, text: string) => files.set(file, text),
  };
}

const options = (over: Partial<ReturnType<typeof parseArgs>> = {}) => ({ ...parseArgs([]), api: 'http://stub.invalid', ...over });

describe('measure-cost-per-claim: arguments', () => {
  it('lists the route provider enum, minus mock, and the route claim limit', () => {
    expect([...PROVIDERS]).toEqual(PROVIDER_ENUM.filter((p) => p !== 'mock'));
    expect(parseArgs(['--k', String(MAX_VERIFY_CLAIMS)]).k).toEqual([MAX_VERIFY_CLAIMS]);
    expect(() => parseArgs(['--k', String(MAX_VERIFY_CLAIMS + 1)])).toThrow(UsageError);
  });

  it('defaults to every real provider, K 1,8,25, n 50, seed 1, a $40 cap', () => {
    const o = parseArgs([]);
    expect(o).toMatchObject({ providers: ['gemini', 'openai', 'claude', 'perplexity'], k: [1, 8, 25], n: 50, seed: 1, capUsd: 40, dryRun: false });
  });

  it('rejects an unknown provider, a bad K and an unknown flag', () => {
    expect(() => parseArgs(['--providers', 'gemini,mistral'])).toThrow(/unknown provider mistral/);
    expect(() => parseArgs(['--providers', 'mock'])).toThrow(UsageError);
    expect(() => parseArgs(['--k', '0'])).toThrow(UsageError);
    expect(() => parseArgs(['--cap-usd', '-1'])).toThrow(UsageError);
    expect(() => parseArgs(['--verbose'])).toThrow(UsageError);
  });
});

describe('measure-cost-per-claim: seeded subsample', () => {
  it('is the same for a seed, different for another seed, and has n distinct corpus lines', () => {
    const corpus = loadCorpus(CORPUS_PATH);
    expect(corpus.length).toBeGreaterThan(50);
    const a = subsample(corpus.length, 50, 1);
    const b = subsample(corpus.length, 50, 1);
    const c = subsample(corpus.length, 50, 2);
    expect(a).toHaveLength(50);
    expect(new Set(a).size).toBe(50);
    expect(a.every((i: number) => i >= 0 && i < corpus.length)).toBe(true);
    expect(b).toEqual(a);
    expect(c).toHaveLength(50);
    expect(c).not.toEqual(a);
  });

  it('uses the corpus line number as the claim id', () => {
    const lines = readFileSync(join(REPO_ROOT, 'docs/research/data/factcheck-bench-subtask4-claim-factuality.jsonl'), 'utf8').split('\n');
    const corpus = loadCorpus(CORPUS_PATH);
    expect(corpus.length).toBeGreaterThan(0);
    const row = corpus[7];
    expect(row.text).toBe(JSON.parse(lines[Number(row.id)]).claim);
  });

  it('sends the same claim ids to every provider and K, deterministically for the seed', async () => {
    const stub = stubApi();
    const { report } = await run(options({ providers: ['gemini', 'openai'], k: [1, 8], n: 9, seed: 5 }), deps(stub));
    const posts = stub.posts();
    expect(posts.length).toBeGreaterThan(0);
    // Per provider: 9 requests at K 1, then 2 at K 8 (8 + 1 claims).
    const idsBy = (provider: string, from: number, to: number) =>
      posts.filter((p) => p.body!.provider === provider).slice(from, to)
        .flatMap((p) => p.body!.claims.map((c) => c.id));
    expect(posts).toHaveLength(22);
    expect(idsBy('gemini', 0, 9)).toHaveLength(9);
    for (const provider of ['gemini', 'openai']) {
      expect(idsBy(provider, 0, 9)).toEqual(report.sampleIds);
      expect(idsBy(provider, 9, 11)).toEqual(report.sampleIds);
    }
    expect(report.sampleIds).toEqual(subsample(CORPUS.length, 9, 5).map(String));
  });
});

describe('measure-cost-per-claim: nearest-rank percentiles', () => {
  it('takes rank ceil(p/100 x n) of the sorted list', () => {
    const values = [70, 10, 100, 40, 20, 90, 30, 60, 50, 80];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 90)).toBe(90);
    expect(percentile(values, 99)).toBe(100);
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([42], 99)).toBe(42);
    expect(percentile([], 50)).toBeNull();
    expect(values[0]).toBe(70); // the input is not sorted in place
  });
});

describe('measure-cost-per-claim: a full run', () => {
  it('reports per-claim cost and latency percentiles, both totals and status counts, and never writes claim text', async () => {
    const stub = stubApi({ costPerClaim: { gemini: 0.035, claude: 0.05 }, otherTrafficUsd: 0.002 });
    const files = new Map<string, string>();
    const { exitCode, report } = await run(options({ providers: ['gemini', 'claude'], k: [1, 8], n: 10, out: 'out/cost.json' }), deps(stub, files));
    expect(exitCode).toBe(EXIT.OK);
    expect(report.cells).toHaveLength(4);
    expect(report.stopped).toBeNull();
    expect(report.engineVersion).toBe('0.11.1');
    expect(report.seed).toBe(1);

    const gemini8 = report.cells.find((c: { provider: string; k: number }) => c.provider === 'gemini' && c.k === 8);
    expect(gemini8).toMatchObject({ nSent: 10, nPriced: 10, requests: 2, model: 'gemini-model' });
    expect(gemini8.costPerClaimUsd.p50).toBeCloseTo(0.035, 12);
    expect(gemini8.costPerClaimUsd.mean).toBeCloseTo(0.035, 12);
    expect(gemini8.latencyPerClaimMs.p99).toBeGreaterThan(0);
    expect(gemini8.statusCounts).toEqual({ contradicted: 4, supported: 6 });
    expect(gemini8.perClaimUsd).toBeCloseTo(0.35, 12);
    // Other traffic lands in the ledger delta only.
    expect(gemini8.ledgerUsd).toBeCloseTo(0.35 + 2 * 0.002, 12);

    expect([...files.keys()].sort()).toEqual(['out/cost.json', 'out/cost.md']);
    const json = files.get('out/cost.json')!;
    const md = files.get('out/cost.md')!;
    expect(JSON.parse(json).cells).toHaveLength(4);
    expect(md).toContain('| Provider (model) | K | n | Verify cost/claim p50 / p90 / p99 | Latency/claim p50 / p90 / p99 | Status counts | Ledger USD vs per-claim USD |');
    expect(md).toContain('| claude (claude-model) | 8 |');
    for (const text of [json, md]) {
      expect(text).not.toContain(TEXT_SENTINEL);
      expect(text).not.toContain(KEY);
    }
    expect(stub.requests.every((r) => r.key === KEY)).toBe(true);
  });

  it('writes the markdown beside the JSON', () => {
    expect(markdownPath('a/b.json')).toBe('a/b.md');
    expect(markdownPath('a/b')).toBe('a/b.md');
  });
});

describe('measure-cost-per-claim: spend cap', () => {
  it('stops the run before a request that would pass the cap, exits 3 and writes the partial output', async () => {
    // $0.10 per claim, K 1, cap $0.35: three requests fit ($0.30 spent), the fourth would reach $0.40.
    const stub = stubApi({ costPerClaim: { gemini: 0.10 } });
    const files = new Map<string, string>();
    const { exitCode, report } = await run(options({ providers: ['gemini', 'openai'], k: [1], n: 5, capUsd: 0.35, out: 'partial.json' }), deps(stub, files));
    expect(exitCode).toBe(EXIT.CAP);
    expect(stub.posts()).toHaveLength(3);
    expect(stub.posts().every((p) => p.body!.provider === 'gemini')).toBe(true);
    expect(report.stopped).toMatchObject({ reason: 'spend_cap', provider: 'gemini', k: 1, capUsd: 0.35 });
    expect(report.stopped.spentSinceStartUsd + report.stopped.reserveUsd).toBeGreaterThan(0.35);

    expect(files.has('partial.json')).toBe(true);
    const written = JSON.parse(files.get('partial.json')!);
    expect(written.cells).toHaveLength(1);
    expect(written.cells[0]).toMatchObject({ provider: 'gemini', k: 1, nSent: 3, nPriced: 3 });
    expect(written.stopped.reason).toBe('spend_cap');
    expect(files.get('partial.md')).toContain('Stopped early: spend_cap');
  });

  it('reserves K x $0.10 before a provider has a measured batch', async () => {
    // K 8 reserves $0.80, which is over a $0.50 cap, so nothing is sent.
    const stub = stubApi();
    const { exitCode, report } = await run(options({ providers: ['claude'], k: [8], n: 8, capUsd: 0.5 }), deps(stub));
    expect(exitCode).toBe(EXIT.CAP);
    expect(stub.posts()).toHaveLength(0);
    expect(report.stopped.reserveUsd).toBeCloseTo(8 * RESERVE_PER_CLAIM_USD, 12);
  });

  it('scales the reserve by K, so a cheap K 1 batch does not shrink the reserve for K 25', async () => {
    // K 1 at $0.10/claim spends $0.20 over 2 requests; K 25 would need a $2.50 reserve, over a $1 cap.
    const stub = stubApi({ costPerClaim: { gemini: 0.10 } });
    const { exitCode, report } = await run(options({ providers: ['gemini'], k: [1, 25], n: 2, capUsd: 1 }), deps(stub));
    expect(exitCode).toBe(EXIT.CAP);
    expect(stub.posts()).toHaveLength(2);
    expect(report.stopped).toMatchObject({ reason: 'spend_cap', k: 25 });
    expect(report.stopped.reserveUsd).toBeCloseTo(25 * 0.10, 9);
  });
});

describe('measure-cost-per-claim: provider stops', () => {
  it('stops a provider on 429 and records why, then measures the next provider', async () => {
    const stub = stubApi({ failWith: { openai: { status: 429, body: { error: 'rate_limited' } } } });
    const { exitCode, report } = await run(options({ providers: ['openai', 'gemini'], k: [1, 8], n: 4 }), deps(stub));
    expect(exitCode).toBe(EXIT.OK);
    const openaiPosts = stub.posts().filter((p) => p.body!.provider === 'openai');
    expect(openaiPosts).toHaveLength(1);
    expect(report.providerStops).toEqual({ openai: { httpStatus: 429, error: 'rate_limited', k: 1 } });
    const gemini = report.cells.filter((c: { provider: string }) => c.provider === 'gemini');
    expect(gemini).toHaveLength(2);
    expect(gemini.map((c: { nSent: number }) => c.nSent)).toEqual([4, 4]);
    expect(renderMarkdown(report)).toContain('- openai: HTTP 429 rate_limited (K 1)');
  });

  it('stops a provider on 503 (grounding allowance or spend cap)', async () => {
    const stub = stubApi({ failWith: { gemini: { status: 503, body: { error: 'grounding_allowance_exhausted' } } } });
    const { report } = await run(options({ providers: ['gemini'], k: [8], n: 8 }), deps(stub));
    expect(stub.posts()).toHaveLength(1);
    expect(report.providerStops.gemini).toEqual({ httpStatus: 503, error: 'grounding_allowance_exhausted', k: 8 });
  });
});

describe('measure-cost-per-claim: dry run', () => {
  it('prints the plan and the worst case and sends no request', async () => {
    let calls = 0;
    const lines: string[] = [];
    const { exitCode, report } = await run(options({ dryRun: true }), {
      fetch: async () => { calls += 1; throw new Error('no request in a dry run'); },
      key: KEY,
      log: (m: string) => lines.push(m),
    });
    expect(exitCode).toBe(EXIT.OK);
    expect(calls).toBe(0);
    // 4 providers x (50 + 7 + 2) requests; 4 x 3 x 50 claims at $0.10.
    expect(report.plan).toMatchObject({ requests: 236, claims: 600, worstCaseUsd: 60 });
    expect(report.plan).toEqual(plan(options()));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('236 requests');
    expect(lines[0]).toContain('$60.00');
  });
});

describe('measure-cost-per-claim: which key it sends', () => {
  const MEASUREMENT = ['cost', 'MEASUREKEY', 'never-print'].join('-');
  const noFiles = { measurement: '/nonexistent/measurement-key.env', admin: '/nonexistent/hosted-api-key.env' };

  function keyDeps(stub: ReturnType<typeof stubApi>, env: Record<string, string>, lines: string[]) {
    const { key: _unused, ...rest } = deps(stub);
    return { ...rest, env, keyFiles: noFiles, log: (line: string) => lines.push(line) };
  }

  it('sends FAULTLINE_MEASUREMENT_KEY over the admin key, with no unlabelled warning', async () => {
    const stub = stubApi();
    const lines: string[] = [];
    const result = await run(options({ providers: ['gemini'], k: [8], n: 8 }), keyDeps(stub, { FAULTLINE_MEASUREMENT_KEY: MEASUREMENT, FAULTLINE_ADMIN_KEY: KEY }, lines));
    expect(result.exitCode).toBe(EXIT.OK);
    expect(stub.requests.length).toBeGreaterThan(0);
    expect(stub.requests.every((r) => r.key === MEASUREMENT)).toBe(true);
    expect(lines.join('\n')).not.toMatch(/not labelled/);
    expect(lines.join('\n')).not.toContain(MEASUREMENT);
  });

  it('falls back to the admin key with a printed warning that the run is not labelled', async () => {
    const stub = stubApi();
    const lines: string[] = [];
    const result = await run(options({ providers: ['gemini'], k: [8], n: 8 }), keyDeps(stub, { FAULTLINE_ADMIN_KEY: KEY }, lines));
    expect(result.exitCode).toBe(EXIT.OK);
    expect(stub.requests.length).toBeGreaterThan(0);
    expect(stub.requests.every((r) => r.key === KEY)).toBe(true);
    expect(lines.filter((line) => /WARNING: no measurement key .* not labelled/.test(line))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('with neither key it sends nothing and exits 2', async () => {
    const stub = stubApi();
    const lines: string[] = [];
    const result = await run(options({ providers: ['gemini'], k: [8], n: 8 }), keyDeps(stub, {}, lines));
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(stub.requests).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/no measurement or admin key/);
  });

  it('keeps its client-side spend cap: the default is still USD 40', () => {
    expect(parseArgs([]).capUsd).toBe(40);
  });
});
