#!/usr/bin/env node
/**
 * Cost per verified claim, per provider and per batch size K, at p50, p90 and p99, under a hard spend cap.
 *
 * For each provider and each K it sends the same seeded subsample of the claim-factuality corpus
 * (docs/research/data/factcheck-bench-subtask4-claim-factuality.jsonl) to admin POST /admin/verify-claims,
 * K claims per request. Each result carries that claim's own priced usage (`usage.costUsd`, priced by the
 * same code that prices the batch ledger row), so per-claim percentiles come from the route itself, not
 * from dividing a ledger delta.
 *
 * What K means: the engine makes one provider call per claim, so K changes request size and how many
 * claims run at once (up to the route's concurrency of 4), not how many claims share a model call.
 * Extraction cost is not measured: this route verifies claims as given and skips extraction.
 *
 * Claim ids are the corpus line number (0-based, blank lines skipped). Claim text is sent to the API and
 * never written to stdout, stderr or any output file. Keys and provider response bodies are not logged.
 *
 * Spend guard (--cap-usd, default 40): before every request it reads admin GET /usage
 * `providerBudget.spentUsd`. If (spent since the run started) + (a reserve for the next batch) would pass
 * the cap, it stops the whole run before that request, writes what it has, and exits 3. The reserve is
 * K x 0.10 USD before this provider has a measured batch. After that it is the larger of the largest
 * batch cost seen so far in the run and K x the largest cost per claim seen for this provider, so moving
 * from K 1 to K 25, or from a cheap provider to a dear one, never shrinks the reserve below what the
 * next batch could cost. A batch's cost is the larger of its ledger delta and its per-claim sum. A provider also stops on HTTP 429 or 503 (burst limit,
 * grounding allowance, spend cap, provider not configured); the reason is recorded and the run moves on
 * to the next provider.
 *
 * Percentiles are nearest-rank: sort the n values ascending and take the value at rank ceil(p/100 x n)
 * (1-based). With no values the percentile is null. Cost percentiles use priced claims only
 * (`usage.priced: true`); a claim with no priced usage (a failed call, a provider that reports no token
 * usage, or a server without the per-claim field) counts in n but not in n priced. Latency per claim is
 * one value per request: request wall time / claims in that request.
 *
 * Totals are reported two ways per cell: the /usage ledger delta around each request (includes any other
 * traffic in the same seconds) and the sum of per-claim usage (this run's claims only).
 *
 * The admin key comes from FAULTLINE_ADMIN_KEY or ~/.config/faultline/hosted-api-key.env and is sent only
 * as x-api-key.
 *
 * Usage:
 *   node scripts/measure-cost-per-claim.mjs [--api https://faultline-api.fly.dev] [--providers gemini,openai]
 *     [--k 1,8,25] [--n 50] [--seed 1] [--cap-usd 40] [--out results.json] [--dry-run]
 * Writes <out> (JSON) and the same path with .md in place of .json (a markdown table).
 * Exit codes: 0 done, 2 bad arguments or no key, 3 stopped by the spend cap.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readAdminKey } from './accuracy-g0.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CORPUS_PATH = path.join(REPO_ROOT, 'docs/research/data/factcheck-bench-subtask4-claim-factuality.jsonl');
export const DEFAULT_API = 'https://faultline-api.fly.dev';
/** The route's provider enum minus mock (a test-only provider spends nothing). Kept equal by a test. */
export const PROVIDERS = Object.freeze(['gemini', 'openai', 'claude', 'perplexity']);
export const DEFAULT_PROVIDERS = PROVIDERS;
export const DEFAULT_K = Object.freeze([1, 8, 25]);
/** The route's MAX_VERIFY_CLAIMS. */
export const MAX_K = 25;
export const DEFAULT_N = 50;
export const DEFAULT_SEED = 1;
export const DEFAULT_CAP_USD = 40;
/** Reserve per claim before any batch cost has been measured. */
export const RESERVE_PER_CLAIM_USD = 0.10;
/** Ledger appends are fire-and-forget; wait this long before reading /usage after a request. */
export const SETTLE_MS = 3000;
export const EXIT = Object.freeze({ OK: 0, USAGE: 2, CAP: 3 });

export class UsageError extends Error {}

function list(value, name) {
  const items = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new UsageError(`${name} is empty`);
  return items;
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a positive integer`);
  return n;
}

export function parseArgs(argv) {
  const opts = {
    api: DEFAULT_API, providers: [...DEFAULT_PROVIDERS], k: [...DEFAULT_K], n: DEFAULT_N, seed: DEFAULT_SEED,
    capUsd: DEFAULT_CAP_USD, out: null, dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--api': opts.api = value().replace(/\/+$/, ''); break;
      case '--providers': opts.providers = list(value(), '--providers'); break;
      case '--k': opts.k = list(value(), '--k').map((v) => positiveInt(v, '--k')); break;
      case '--n': opts.n = positiveInt(value(), '--n'); break;
      case '--seed': {
        const seed = Number(value());
        if (!Number.isInteger(seed)) throw new UsageError('--seed must be an integer');
        opts.seed = seed;
        break;
      }
      case '--cap-usd': {
        const cap = Number(value());
        if (!Number.isFinite(cap) || cap <= 0) throw new UsageError('--cap-usd must be a positive number');
        opts.capUsd = cap;
        break;
      }
      case '--out': opts.out = value(); break;
      case '--dry-run': opts.dryRun = true; break;
      default: throw new UsageError(`unknown argument ${arg}`);
    }
  }
  for (const p of opts.providers) {
    if (!PROVIDERS.includes(p)) throw new UsageError(`unknown provider ${p} (expected one of ${PROVIDERS.join(', ')})`);
  }
  for (const k of opts.k) {
    if (k > MAX_K) throw new UsageError(`--k ${k} is over the route's limit of ${MAX_K} claims per request`);
  }
  return opts;
}

// ── Sampling and statistics ──────────────────────────────────────────────────

/** mulberry32: a small seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n distinct indices from 0..count-1, in sampled order, by a seeded partial Fisher-Yates shuffle. */
export function subsample(count, n, seed) {
  if (n > count) throw new UsageError(`--n ${n} is more than the ${count} claims in the corpus`);
  const rand = mulberry32(seed);
  const idx = Array.from({ length: count }, (_, i) => i);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (count - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n);
}

/** Corpus lines as { id, text }; id is the 0-based line number. Text stays in memory only. */
export function loadCorpus(file = CORPUS_PATH) {
  const rows = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    rows.push({ id: String(i), text: JSON.parse(line).claim });
  });
  return rows;
}

/** Nearest-rank percentile: the value at 1-based rank ceil(p/100 x n) of the sorted list; null when empty. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

function stats(values, withMean = false) {
  const out = { p50: percentile(values, 50), p90: percentile(values, 90), p99: percentile(values, 99) };
  return withMean ? { ...out, mean: mean(values) } : out;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function plan(opts) {
  const perProvider = opts.k.reduce((s, k) => s + Math.ceil(opts.n / k), 0);
  const claims = opts.providers.length * opts.k.length * opts.n;
  return {
    providers: opts.providers, k: opts.k, n: opts.n, seed: opts.seed, capUsd: opts.capUsd,
    requests: perProvider * opts.providers.length,
    claims,
    worstCaseUsd: claims * RESERVE_PER_CLAIM_USD,
  };
}

// ── Output ───────────────────────────────────────────────────────────────────

export function markdownPath(out) {
  return out.endsWith('.json') ? out.slice(0, -'.json'.length) + '.md' : out + '.md';
}

const usd = (v) => (v === null || v === undefined ? 'n/a' : `$${v.toFixed(6)}`);
const ms = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v)} ms`);
const counts = (obj) => Object.entries(obj).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

export function renderMarkdown(report) {
  const lines = [
    `# Cost per verified claim`,
    '',
    `Engine ${report.engineVersion ?? 'unknown'}, seed ${report.seed}, ${report.startedAt} to ${report.endedAt}.` +
      (report.stopped ? ` Stopped early: ${report.stopped.reason}.` : ''),
    '',
    'Percentiles are nearest-rank. Cost percentiles use priced claims only.',
    '',
    '| Provider (model) | K | n | Verify cost/claim p50 / p90 / p99 | Latency/claim p50 / p90 / p99 | Status counts | Ledger USD vs per-claim USD |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const c of report.cells) {
    const cost = `${usd(c.costPerClaimUsd.p50)} / ${usd(c.costPerClaimUsd.p90)} / ${usd(c.costPerClaimUsd.p99)}`;
    const lat = `${ms(c.latencyPerClaimMs.p50)} / ${ms(c.latencyPerClaimMs.p90)} / ${ms(c.latencyPerClaimMs.p99)}`;
    lines.push(
      `| ${c.provider} (${c.model ?? 'unknown'}) | ${c.k} | ${c.nSent} (${c.nPriced} priced) | ${cost} | ${lat} | ${counts(c.statusCounts)} | ${usd(c.ledgerUsd)} vs ${usd(c.perClaimUsd)} |`,
    );
  }
  const stops = Object.entries(report.providerStops);
  if (stops.length > 0) {
    lines.push('', 'Providers stopped early:', '');
    for (const [p, s] of stops) lines.push(`- ${p}: HTTP ${s.httpStatus} ${s.error ?? ''} (K ${s.k})`.trimEnd());
  }
  return lines.join('\n') + '\n';
}

function writeOutputs(out, report, write) {
  if (!out) return;
  write(out, JSON.stringify(report, null, 1) + '\n');
  write(markdownPath(out), renderMarkdown(report));
}

// ── Run ──────────────────────────────────────────────────────────────────────

function newCell(provider, k) {
  return {
    provider, k, model: null, requests: 0, nSent: 0, nPriced: 0, statusCounts: {}, apiErrorCounts: {}, httpErrors: {},
    ledgerUsd: 0, perClaimUsd: 0, costs: [], latencies: [], models: {},
  };
}

function finishCell(cell) {
  const { costs, latencies, models, ...rest } = cell;
  const model = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { ...rest, model, costPerClaimUsd: stats(costs, true), latencyPerClaimMs: stats(latencies) };
}

/**
 * Run the measurement. deps: fetch, key, sleep, now, log, write, corpus (array of { id, text }).
 * Returns { exitCode, report }; the report is also written to opts.out (and the .md beside it).
 */
export async function run(opts, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((t) => new Promise((r) => setTimeout(r, t)));
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((msg) => console.error(msg));
  const write = deps.write ?? ((file, text) => writeFileSync(file, text));
  const thePlan = plan(opts);

  if (opts.dryRun) {
    log(`dry run: ${thePlan.requests} requests, ${thePlan.claims} claims; worst case $${thePlan.worstCaseUsd.toFixed(2)} at $${RESERVE_PER_CLAIM_USD.toFixed(2)}/claim; cap $${opts.capUsd}`);
    return { exitCode: EXIT.OK, report: { dryRun: true, plan: thePlan } };
  }

  const key = deps.key ?? readAdminKey();
  if (!key) {
    log('no admin key (set FAULTLINE_ADMIN_KEY or ~/.config/faultline/hosted-api-key.env)');
    return { exitCode: EXIT.USAGE, report: null };
  }
  const corpus = deps.corpus ?? loadCorpus();
  const sample = subsample(corpus.length, opts.n, opts.seed).map((i) => corpus[i]);

  const call = async (method, route, body) => {
    const res = await fetchFn(opts.api + route, {
      method,
      headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(600_000),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, json };
  };
  const readSpent = async () => {
    const res = await call('GET', '/usage');
    const spent = res.json?.providerBudget?.spentUsd;
    if (!res.ok || typeof spent !== 'number') throw new Error(`GET /usage -> ${res.status}: no providerBudget.spentUsd`);
    return spent;
  };

  const health = await call('GET', '/health');
  const startSpent = await readSpent();
  const startedAt = new Date(now()).toISOString();
  const cells = [];
  const providerStops = {};
  let maxBatchUsd = 0;
  /** provider -> largest cost per claim of any measured batch. */
  const maxPerClaimUsd = {};
  let stopped = null;

  const report = () => ({
    api: opts.api,
    engineVersion: health.json?.version ?? null,
    engineCommit: health.json?.commit ?? null,
    seed: opts.seed,
    n: opts.n,
    capUsd: opts.capUsd,
    plan: thePlan,
    startedAt,
    endedAt: new Date(now()).toISOString(),
    sampleIds: sample.map((c) => c.id),
    stopped,
    providerStops,
    cells: cells.map(finishCell),
  });

  try {
    await measure();
  } catch (err) {
    // Keep what was measured before the failure, then let the error surface.
    stopped = { reason: 'error' };
    writeOutputs(opts.out, report(), write);
    throw err;
  }
  const final = report();
  writeOutputs(opts.out, final, write);
  return { exitCode: stopped ? EXIT.CAP : EXIT.OK, report: final };

  /** Every provider, every K, every batch; stops early by setting `stopped` or a provider stop. */
  async function measure() {
    outer:
    for (const provider of opts.providers) {
      for (const k of opts.k) {
        const cell = newCell(provider, k);
        cells.push(cell);
        for (const batch of chunk(sample, k)) {
          const before = await readSpent();
          const spentSinceStart = before - startSpent;
          const reserve = provider in maxPerClaimUsd
            ? Math.max(maxBatchUsd, k * maxPerClaimUsd[provider])
            : k * RESERVE_PER_CLAIM_USD;
          if (spentSinceStart + reserve > opts.capUsd) {
            stopped = { reason: 'spend_cap', provider, k, spentSinceStartUsd: spentSinceStart, reserveUsd: reserve, capUsd: opts.capUsd };
            log(`stopped: $${spentSinceStart.toFixed(4)} spent + $${reserve.toFixed(4)} reserve would pass the $${opts.capUsd} cap`);
            break outer;
          }

          const t0 = now();
          const res = await call('POST', '/admin/verify-claims', { provider, claims: batch });
          const wallMs = now() - t0;
          cell.requests += 1;

          if (res.status === 429 || res.status === 503) {
            providerStops[provider] = { httpStatus: res.status, error: typeof res.json?.error === 'string' ? res.json.error : null, k };
            log(`${provider}: stopped on HTTP ${res.status}`);
            continue outer;
          }
          if (!res.ok || !Array.isArray(res.json?.results)) {
            cell.httpErrors[res.status] = (cell.httpErrors[res.status] ?? 0) + 1;
            continue;
          }

          await sleep(SETTLE_MS);
          const after = await readSpent();
          const ledgerDelta = after - before;
          let batchClaimUsd = 0;
          for (const r of res.json.results) {
            cell.nSent += 1;
            const status = r.status ?? 'unknown';
            cell.statusCounts[status] = (cell.statusCounts[status] ?? 0) + 1;
            if (r.apiError) {
              const reason = r.apiErrorReason ?? 'unknown';
              cell.apiErrorCounts[reason] = (cell.apiErrorCounts[reason] ?? 0) + 1;
            }
            if (r.model) cell.models[r.model] = (cell.models[r.model] ?? 0) + 1;
            if (r.usage?.priced === true && typeof r.usage.costUsd === 'number') {
              cell.nPriced += 1;
              cell.costs.push(r.usage.costUsd);
              batchClaimUsd += r.usage.costUsd;
            }
          }
          cell.latencies.push(wallMs / batch.length);
          cell.ledgerUsd += ledgerDelta;
          cell.perClaimUsd += batchClaimUsd;
          // The larger of the two readings, so other traffic can only make the guard stricter.
          const batchUsd = Math.max(ledgerDelta, batchClaimUsd);
          maxBatchUsd = Math.max(maxBatchUsd, batchUsd);
          maxPerClaimUsd[provider] = Math.max(maxPerClaimUsd[provider] ?? 0, batchUsd / batch.length);
        }
      }
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      return EXIT.USAGE;
    }
    throw err;
  }
  const { exitCode, report } = await run(opts);
  if (report) console.log(JSON.stringify(opts.dryRun ? report : { ...report, cells: report.cells.map(({ provider, k, nSent, nPriced, costPerClaimUsd }) => ({ provider, k, nSent, nPriced, costPerClaimUsd })) }, null, 1));
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
