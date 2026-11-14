#!/usr/bin/env node
// Validates: prereg G0 §2, §5, §6, §7 (docs/research/2026-10-02-prereg-verdict-accuracy-g0-v1.md)
/**
 * Runner for the pre-registered verdict-accuracy baseline (G0).
 *
 * Sends each Factcheck-Bench claim, as given, to the hosted API's admin-only
 * POST /admin/verify-claims (production engine, key, model and ledgers) and
 * writes one JSONL row per item. It stores status labels and flags only, never
 * grounded text (Google grounding terms).
 *
 *   node scripts/accuracy-g0.mjs --set full|verify-subsample
 *        [--api <url>] [--out <path>] [--resume] [--engine-sha <sha>] [--allowance-api <url>]
 *        [--arm google|parallel|parallel-fast|both] [--sample <N> --seed <S>]
 *        [--label <name>] [--judge-model <id>] [--price-in <usd/M> --price-out <usd/M> --cap-usd <usd>]
 *
 * Judge model A/B (docs/research/2026-11-14-prereg-judge-model-ab-v1.md): --label names the
 * arm in its rows (the scorer reads it as the arm name), so several runs of one grounding arm
 * against local APIs with different judge models score side by side. --judge-model stops the
 * run as invalid when a verdict names any other judge model. Each row records the claim's
 * input and output tokens and its Parallel calls. --price-in/--price-out/--cap-usd price those
 * tokens at the arm's own list price (plus 0.005 USD a Parallel call) and stop the arm, after
 * its first 25 claims, when the projected cost of the whole arm would pass --cap-usd.
 *
 * --arm picks the grounding arm (docs/grounding-providers.md), sent to the route as
 * `grounding` (and `parallelMode`): google (arm A, the default) is Gemini with Google
 * Search; parallel (arm P) is Parallel's Search API in advanced mode, then Gemini with
 * no search tool; parallel-fast is arm P on Parallel's fast mode (optional extra);
 * both runs google then parallel on the same items. Each arm writes its own out file
 * and attempt ledger (`<base>.<arm>.jsonl` unless one arm and --out are given), and
 * every run ends with `<base>.summary.json` from the scorer's --arms mode: balanced
 * accuracy per arm, the paired bootstrap 95% CI of BA(P) - BA(A) (2,000 resamples,
 * the scorer's fixed seed), unverified rate, not-checkable rate, mean cost per claim
 * and Google grounded calls per arm.
 *
 * --sample N --seed S keeps a seeded random subsample of N items of the set (the same
 * N items for every arm and every run with that seed). A sampled run is an arm
 * comparison, not the pre-registered G0 run: the scorer's prereg validity rules (the
 * full id set) are not applied to it.
 *
 * --allowance-api adds a second engine whose grounded-prompt count joins the daily guard. A branch
 * run (engine started on the runner) shares the Google key with production, so the guard must
 * count both (GoPMO 1.18.11.7.18, A0).
 *
 * Guards (each is a prereg rule, not a tunable):
 *   - the gold file must hash to GOLD_SHA256, else nothing is sent   (§2, §5)
 *   - before the run and before every batch, GET /usage: stop if today's
 *     grounded prompts + the batch would pass 1,000                  (§7)
 *   - apiError items are retried up to 3 times with backoff          (§6)
 *   - at most 4 provider calls per item across every process: each call
 *     is appended to <out>.attempts.jsonl and flushed BEFORE it is made,
 *     and --resume restores the counts from that ledger              (A2.7)
 *   - the engine model or commit changing mid-run stops the run      (§5)
 *
 * The key is the measurement key when one is set: FAULTLINE_MEASUREMENT_KEY, else
 * the FAULTLINE_MEASUREMENT_KEY= line of ~/.config/faultline/measurement-key.env.
 * Its spend rows on the API carry tier 'measurement', apart from web traffic.
 * With no measurement key it falls back to the admin key (FAULTLINE_ADMIN_KEY,
 * else the FAULTLINE_API_KEY= line of ~/.config/faultline/hosted-api-key.env)
 * and prints a warning that the run's spend is not labelled. The key is sent as
 * x-api-key and never printed.
 *
 * Exit codes:
 *   0 all items answered        2 refused before sending anything (hash, args,
 *   1 error (HTTP/protocol)       key, engine identity)
 *   3 grounding allowance guard stop, resumable with --resume
 *   4 INVALID run: model or engine commit changed (prereg §5)
 *   5 provider-spend cap reached (503), resumable with --resume
 */
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const GOLD_SHA256 = 'b87f971ce324c87e0427f100fe24b50594b9d44e3a764490b1bef188917dbae1';
export const GOLD_PATH = path.join(REPO_ROOT, 'docs/research/data/factcheck-bench-subtask4-claim-factuality.jsonl');
export const SUBSAMPLE_PATH = path.join(REPO_ROOT, 'docs/research/data/accuracy-g0-verify-subsample-ids.json');
export const DEFAULT_API = 'https://faultline-api.fly.dev';
/** Prereg §7: the lever-1 daily cap on grounded prompts, leaving room for production. */
export const DAILY_GROUNDED_CAP = 1000;
/**
 * With --allowance-api, production keeps spending the same key while a batch is in flight, so the
 * guard leaves this many prompts for it (codex review of f5d637c, finding 1). Production served 0
 * grounded prompts on 2026-10-20 by 03:50Z (admin GET /usage); 100 is headroom, not a forecast.
 * ACCEPTED RESIDUAL (codex re-review of f68d2f1, finding 1): the reads are snapshots, so production
 * spending more than 100 grounded prompts during one in-flight batch (about a minute) would carry
 * the day past 1,000. No reservation can be shared with production, so this is stated, not closed.
 * The 1,000 is the prereg's own lever below Google's 1,500 free daily prompts; the cost of an
 * overshoot is the per-prompt grounding price on the excess.
 */
export const PRODUCTION_HEADROOM = 100;
/** Prereg §6: the route takes up to 25 claims. */
export const BATCH_SIZE = 25;
/** Prereg §6: retry any apiError item up to 3 times. */
export const MAX_RETRIES = 3;
/** A2.7: "up to 3 times" is at most 4 provider calls per item, across every process. */
export const MAX_CALLS = MAX_RETRIES + 1;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
/** Fixed location of the hosted admin key; never derived from input. */
const KEY_FILE = `${homedir()}/.config/faultline/hosted-api-key.env`;
/** Fixed location of the measurement key; never derived from input. */
const MEASUREMENT_KEY_FILE = `${homedir()}/.config/faultline/measurement-key.env`;
/** Printed when a run falls back to the admin key. Fixed text: it never holds a key. */
export const UNLABELLED_WARNING =
  'WARNING: no measurement key (FAULTLINE_MEASUREMENT_KEY or ~/.config/faultline/measurement-key.env); '
  + 'using the admin key, so this run is not labelled: its spend rows read as enterprise (the admin key\'s label), not measurement.';

/** Progress and stop lines. They never contain the key: it only goes into a header. */
function writeLine(stream, line) {
  stream.write(`${line}\n`);
}

export const EXIT = Object.freeze({
  OK: 0, ERROR: 1, REFUSED: 2, ALLOWANCE_STOP: 3, INVALID: 4, SPEND_CAP: 5,
});

class RunStop extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ── Arguments ────────────────────────────────────────────────────────────────

/** The arms --arm takes, and what each sends to POST /admin/verify-claims. */
export const ARMS = Object.freeze({
  google: { grounding: 'google' },
  parallel: { grounding: 'parallel', parallelMode: 'advanced' },
  'parallel-fast': { grounding: 'parallel', parallelMode: 'fast' },
});

/** The arms one --arm value runs, in order. */
export function armsOf(arm) {
  return arm === 'both' ? ['google', 'parallel'] : [arm];
}

export function parseArgs(argv) {
  const options = {
    set: undefined, api: DEFAULT_API, out: undefined, resume: false, engineSha: undefined, allowanceApi: undefined,
    gold: GOLD_PATH, subsample: SUBSAMPLE_PATH, retryBaseMs: 2000, arm: 'google', sample: undefined, seed: undefined,
    label: undefined, judgeModel: undefined, priceIn: undefined, priceOut: undefined, capUsd: undefined,
  };
  const valueFlags = {
    '--set': 'set', '--api': 'api', '--out': 'out', '--engine-sha': 'engineSha',
    '--gold': 'gold', '--subsample': 'subsample', '--retry-base-ms': 'retryBaseMs', '--allowance-api': 'allowanceApi',
    '--arm': 'arm', '--sample': 'sample', '--seed': 'seed',
    '--label': 'label', '--judge-model': 'judgeModel', '--price-in': 'priceIn', '--price-out': 'priceOut', '--cap-usd': 'capUsd',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--resume') { options.resume = true; continue; }
    const key = valueFlags[arg];
    if (!key) throw new Error(`unknown argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    options[key] = value;
    i += 1;
  }
  if (options.set !== 'full' && options.set !== 'verify-subsample') {
    throw new Error('--set must be full or verify-subsample');
  }
  if (options.resume && !options.out) throw new Error('--resume needs --out <the file to resume>');
  if (options.arm !== 'both' && !Object.hasOwn(ARMS, options.arm)) throw new Error('--arm must be google, parallel, parallel-fast or both');
  if ((options.sample === undefined) !== (options.seed === undefined)) throw new Error('--sample and --seed go together');
  if (options.sample !== undefined) {
    if (!/^[1-9]\d*$/.test(options.sample)) throw new Error('--sample must be a whole number >= 1');
    if (!/^\d+$/.test(options.seed)) throw new Error('--seed must be a whole number >= 0');
    options.sample = Number(options.sample);
    options.seed = Number(options.seed);
  }
  if (options.label !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(options.label)) throw new Error('--label must be 1-64 of a-z 0-9 . _ -');
  if (options.label !== undefined && options.arm === 'both') throw new Error('--label names one arm; it does not go with --arm both');
  const priced = [options.priceIn, options.priceOut, options.capUsd].filter((v) => v !== undefined).length;
  if (priced !== 0 && priced !== 3) throw new Error('--price-in, --price-out and --cap-usd go together');
  for (const key of ['priceIn', 'priceOut', 'capUsd']) {
    if (options[key] === undefined) continue;
    options[key] = Number(options[key]);
    if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a number >= 0`);
  }
  options.retryBaseMs = Number(options.retryBaseMs);
  if (!Number.isFinite(options.retryBaseMs) || options.retryBaseMs < 0) throw new Error('--retry-base-ms must be >= 0');
  options.api = options.api.replace(/\/+$/, '');
  if (options.allowanceApi !== undefined) options.allowanceApi = options.allowanceApi.replace(/\/+$/, '');
  if (options.engineSha !== undefined) options.engineSha = normalizeSha(options.engineSha);
  options.out ??= path.join(REPO_ROOT, 'docs/research/data', `accuracy-g0-${defaultRunId(options.set)}.jsonl`);
  return options;
}

/** The base path every arm's file and the summary hang off: the out path without `.jsonl`. */
export function outBase(out) {
  return out.endsWith('.jsonl') ? out.slice(0, -'.jsonl'.length) : out;
}

/** The out file one arm writes: --out itself for a single arm, else `<base>.<arm>.jsonl`. */
export function armOut(options, arm) {
  return armsOf(options.arm ?? 'google').length === 1 ? options.out : `${outBase(options.out)}.${arm}.jsonl`;
}

/** The summary file a run ends with. */
export function summaryPath(options) {
  return `${outBase(options.out)}.summary.json`;
}

/**
 * A seeded subsample of `items`: a Fisher-Yates shuffle driven by mulberry32(seed),
 * the first n kept, returned ascending by id. Same items, seed and n give the same
 * subsample on every machine.
 */
export function seededSample(items, n, seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length)).sort((x, y) => x.id - y.id);
}

function normalizeSha(value) {
  const sha = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('--engine-sha must be a 7 to 40 character hex git sha');
  return sha;
}

function defaultRunId(set, now = new Date()) {
  return `${set}-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

/** Fixed env-file line patterns: `[export ]NAME=value`. */
const KEY_LINE = Object.freeze({
  FAULTLINE_API_KEY: /^\s*(?:export\s+)?FAULTLINE_API_KEY\s*=\s*(.*)$/,
  FAULTLINE_MEASUREMENT_KEY: /^\s*(?:export\s+)?FAULTLINE_MEASUREMENT_KEY\s*=\s*(.*)$/,
});

/** The value of `name=` in an env file, or '' when the file or the line is missing. */
function readKeyLine(file, name) {
  if (!existsSync(file)) return '';
  const pattern = KEY_LINE[name];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = pattern.exec(line);
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}

/** The admin key, from env or the hosted-api-key file. Never logged. */
export function readAdminKey(env = process.env, file = KEY_FILE) {
  const fromEnv = (env.FAULTLINE_ADMIN_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  return readKeyLine(file, 'FAULTLINE_API_KEY');
}

/** The measurement key, from env or the measurement-key file. Never logged. */
export function readMeasurementKey(env = process.env, file = MEASUREMENT_KEY_FILE) {
  const fromEnv = (env.FAULTLINE_MEASUREMENT_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  return readKeyLine(file, 'FAULTLINE_MEASUREMENT_KEY');
}

/**
 * The key a measurement run sends: the measurement key when one is set
 * (`labelled: true`), else the admin key (`labelled: false`; the caller prints
 * UNLABELLED_WARNING), else `{ key: '' }`. Never logged.
 */
export function readRunKey(env = process.env, files = {}) {
  const measurement = readMeasurementKey(env, files.measurement ?? MEASUREMENT_KEY_FILE);
  if (measurement) return { key: measurement, labelled: true };
  const admin = readAdminKey(env, files.admin ?? KEY_FILE);
  return { key: admin, labelled: false };
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Gold items; the id is the 0-based line number (prereg §2). */
export function loadGold(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, id) => {
      const row = JSON.parse(line);
      return { id, claim: row.claim, gold: row.label };
    });
}

/** The items a set covers, ascending by id. */
export function selectItems(set, gold, subsampleFile) {
  if (set === 'full') return gold;
  const { ids } = JSON.parse(readFileSync(subsampleFile, 'utf8'));
  if (!Array.isArray(ids) || ids.length !== 100) throw new Error('subsample file must list 100 ids');
  const byId = new Map(gold.map((item) => [item.id, item]));
  return [...ids].sort((a, b) => a - b).map((id) => {
    const item = byId.get(id);
    if (!item || (item.gold !== 'true' && item.gold !== 'false')) throw new Error(`subsample id ${id} is not a binary gold item`);
    return item;
  });
}

/** Rows already written to the out file, by id. */
export function readDone(file) {
  const done = new Map();
  if (!existsSync(file)) return done;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line);
    if (done.has(row.id)) throw new Error(`out file has id ${row.id} twice`);
    done.set(row.id, row);
  }
  return done;
}

// ── Attempt ledger (A2.7 across --resume) ────────────────────────────────────

/**
 * The attempt ledger sits beside the out file. One line per provider call,
 * `{id, attempt, ts}`, appended and fsynced BEFORE the call is made, so a call
 * that happened is never missing from it, whichever way the process ends.
 */
export function ledgerPath(out) {
  return `${out}.attempts.jsonl`;
}

/** Calls already made per id, restored from the ledger. Refuses a gap or repeat. */
export function readLedger(file, arm = 'google') {
  const counts = new Map();
  if (!existsSync(file)) return counts;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const { id, attempt, arm: lineArm = 'google' } = JSON.parse(line);
    // A line from before arms existed has no arm field and was a google run.
    if (lineArm !== arm) throw new RunStop(EXIT.REFUSED, `REFUSED: attempt ledger ${file} holds arm ${lineArm}, not ${arm}`);
    const expected = (counts.get(id) ?? 0) + 1;
    if (attempt !== expected) throw new Error(`attempt ledger ${file}: id ${id} has attempt ${attempt} where ${expected} was due`);
    counts.set(id, attempt);
  }
  return counts;
}

/** Append one call per item and flush it to disk before the request goes out. */
function recordCalls(file, entries, arm = 'google') {
  const ts = new Date().toISOString();
  const text = entries.map(({ id, attempt }) => JSON.stringify({ id, attempt, arm, ts })).join('\n') + '\n';
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * GET /health is a public read and the measurement key may not call it (403), so it goes out with
 * no key header at all. Every other request carries the run key.
 */
function makeClient(api, key) {
  return async function request(method, route, body) {
    const isPublic = method === 'GET' && route === '/health';
    const response = await fetch(`${api}${route}`, {
      method,
      headers: { ...(isPublic ? {} : { 'x-api-key': key }), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, json };
  };
}

async function readHealth(request) {
  const { status, json } = await request('GET', '/health');
  if (status !== 200 || !json) throw new RunStop(EXIT.ERROR, `GET /health answered ${status}`);
  const commit = typeof json.commit === 'string' && json.commit !== '' ? json.commit.toLowerCase() : null;
  return { commit, version: json.version ?? null };
}

async function readGroundedPrompts(request, strict = false) {
  const { status, json } = await request('GET', '/usage');
  const allowance = json?.groundingAllowance;
  const count = allowance?.groundedPrompts;
  if (status !== 200 || typeof count !== 'number') {
    throw new RunStop(EXIT.ERROR, `GET /usage answered ${status} without groundingAllowance.groundedPrompts (is the key the measurement or admin key?)`);
  }
  // Branch mode only (strict): a count the guard cannot trust stops the run rather than letting it
  // spend (codex review of f5d637c). Deployed mode keeps the original check, unchanged.
  if (!strict) return { count, day: allowance.day, resetsAt: allowance.resetsAt };
  if (!Number.isSafeInteger(count) || count < 0 || typeof allowance.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(allowance.day)) {
    throw new RunStop(EXIT.ERROR, `GET /usage answered an unusable allowance (count ${count}, day ${allowance.day})`);
  }
  if (typeof allowance.ledgerWriteFailures === 'number' && allowance.ledgerWriteFailures > 0) {
    throw new RunStop(EXIT.ERROR, `GET /usage reports ${allowance.ledgerWriteFailures} grounding-ledger write failures, so its count is not complete`);
  }
  return { count, day: allowance.day, resetsAt: allowance.resetsAt };
}

// ── Guards ───────────────────────────────────────────────────────────────────

/**
 * Prereg §7: stop before a batch that would take today's count past 1,000. With --allowance-api
 * the count is the sum over every engine that spends the same Google key.
 */
// The highest same-day count each engine has reported in this process. A lower read later means the
// engine's counter was reset (a lost ledger), so its count no longer covers the day (codex
// re-review of a2af549, finding 7).
const highestSeen = new Map();

async function guardAllowance(requests, batchSize, log) {
  const reads = [];
  for (const request of requests) reads.push(await readGroundedPrompts(request, requests.length > 1));
  if (requests.length > 1) {
    reads.forEach((read, i) => {
      const key = `${i}:${read.day}`;
      const prior = highestSeen.get(key);
      if (prior !== undefined && read.count < prior) {
        throw new RunStop(EXIT.ERROR, `STOP: engine ${i} reported ${read.count} grounded prompts on ${read.day} after reporting ${prior}; its counter was reset, so the daily guard cannot trust it`);
      }
      highestSeen.set(key, Math.max(prior ?? 0, read.count));
    });
  }
  const days = [...new Set(reads.map((read) => read.day))];
  if (days.length > 1) {
    throw new RunStop(EXIT.ALLOWANCE_STOP, `STOP (allowance guard): the engines report different allowance days (${days.join(', ')}). Resume with --resume.`);
  }
  const count = reads.reduce((sum, read) => sum + read.count, 0);
  const headroom = reads.length > 1 ? PRODUCTION_HEADROOM : 0;
  if (count + batchSize + headroom > DAILY_GROUNDED_CAP) {
    throw new RunStop(
      EXIT.ALLOWANCE_STOP,
      `STOP (allowance guard): ${count} grounded prompts on ${days[0]} + batch of ${batchSize}${headroom ? ` + production headroom ${headroom}` : ''} would pass ${DAILY_GROUNDED_CAP}. `
        + `Resume after ${reads[0].resetsAt} with --resume.`,
    );
  }
  log(`allowance ${count}/${DAILY_GROUNDED_CAP} on ${days[0]}${reads.length > 1 ? ` (${reads.map((read) => read.count).join(' + ')})` : ''}`);
}

/** Resolve the engine identity at start; refuse when it cannot be established. */
async function resolveEngine(request, options, done) {
  const health = await readHealth(request);
  if (health.commit && options.engineSha && !health.commit.startsWith(options.engineSha) && !options.engineSha.startsWith(health.commit)) {
    throw new RunStop(EXIT.REFUSED, `REFUSED: /health commit ${health.commit} differs from --engine-sha ${options.engineSha}`);
  }
  const engineSha = health.commit ?? options.engineSha;
  if (!engineSha) {
    throw new RunStop(EXIT.REFUSED, 'REFUSED: /health exposes no commit; pass --engine-sha <deployed git sha>');
  }
  const prior = [...new Set([...done.values()].map((row) => row.engineSha))];
  if (prior.length > 0 && (prior.length > 1 || prior[0] !== engineSha)) {
    throw new RunStop(EXIT.INVALID, `INVALID (prereg §5): engine commit changed: out file has ${prior.join(', ')}, engine is now ${engineSha}`);
  }
  return { engineSha, version: health.version, exposed: health.commit !== null };
}

/** Prereg §5: the engine commit must not change during the run. */
async function guardEngine(request, engine) {
  const health = await readHealth(request);
  const changed = engine.exposed ? health.commit !== engine.engineSha : health.version !== engine.version;
  if (changed) {
    const now = engine.exposed ? health.commit : `version ${health.version}`;
    const was = engine.exposed ? engine.engineSha : `version ${engine.version}`;
    throw new RunStop(EXIT.INVALID, `INVALID (prereg §5): engine changed during the run (${was} -> ${now}). Stop; do not score.`);
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST one batch. Returns results by id, or null when the whole call failed. */
async function postBatch(request, batch, stopOnNoAnswer = false, arm = 'google', onAnswer = () => {}) {
  let response;
  try {
    response = await request('POST', '/admin/verify-claims', {
      claims: batch.map((item) => ({ id: String(item.id), text: item.claim })),
      ...ARMS[arm],
    });
  } catch {
    // Branch mode (--allowance-api): a batch that did not answer may still be spending on the
    // engine, and its spend is recorded only when it finishes, so re-sending it could pass the
    // spend bound. Stop instead (opus seat on 462fc29, F3). Deployed mode keeps the prereg retry.
    if (stopOnNoAnswer) {
      throw new RunStop(EXIT.ERROR, 'STOP: a batch did not answer (network error or timeout); its provider calls may still be running, so the run stops rather than re-send it. Resume with --resume after the engine is idle.');
    }
    return null; // network error or timeout: every item in the batch is an apiError attempt
  }
  const { status, json } = response;
  if (status === 503 && /budget/i.test(String(json?.error ?? ''))) {
    throw new RunStop(EXIT.SPEND_CAP, 'STOP: the provider-spend cap is exhausted (503). Resume with --resume after the budget resets.');
  }
  if (status === 401 || status === 403) throw new RunStop(EXIT.ERROR, `the API refused the key (${status})`);
  if (status === 400 || (status === 503 && json?.error === 'provider_not_configured')) {
    throw new RunStop(EXIT.ERROR, `the API rejected the batch (${status} ${json?.error ?? ''})`);
  }
  if (status !== 200 || !Array.isArray(json?.results)) return null;
  // Spend is recorded before any check below can stop the run: a 200 answer was paid for.
  onAnswer(json.results);
  // The engine names the arm it ran. A parallel arm the engine did not run is not that arm.
  const ran = json.grounding ?? 'google';
  if (ran !== ARMS[arm].grounding) {
    throw new RunStop(EXIT.ERROR, `STOP: asked for the ${arm} arm, the engine ran ${ran} grounding`);
  }
  const byId = new Map(json.results.map((result) => [Number(result.id), result]));
  if (byId.size !== batch.length || batch.some((item) => !byId.has(item.id))) {
    throw new RunStop(EXIT.ERROR, 'protocol error: the response ids do not match the batch');
  }
  return byId;
}

/** A finite non-negative number from a response field, else 0. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The spend ledger sits beside the out file too. One line per provider result,
 * `{id, arm, attempt, costUsd, googleGroundingCalls}`, appended and fsynced as each
 * result arrives, so --resume restores what earlier attempts cost and how many
 * Google grounded calls they made, not only how many attempts there were.
 */
export function spendPath(out) {
  return `${out}.spend.jsonl`;
}

/** Cost and Google grounded calls per id over every recorded attempt. Refuses a row from another arm. */
export function readSpend(file, arm) {
  const spent = new Map();
  if (!existsSync(file)) return spent;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line);
    if (row.arm !== arm) throw new RunStop(EXIT.REFUSED, `REFUSED: spend ledger ${file} holds arm ${row.arm}, not ${arm}`);
    const so = spent.get(row.id) ?? emptySpend();
    so.costUsd += count(row.costUsd);
    so.googleGroundingCalls += count(row.googleGroundingCalls);
    so.inputTokens += count(row.inputTokens);
    so.outputTokens += count(row.outputTokens);
    so.parallelCalls += count(row.parallelCalls);
    spent.set(row.id, so);
  }
  return spent;
}

function recordSpend(file, entries) {
  if (entries.length === 0) return;
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** What one item has spent over every attempt. */
export function emptySpend() {
  return { costUsd: 0, googleGroundingCalls: 0, inputTokens: 0, outputTokens: 0, parallelCalls: 0 };
}

/** One item's spend at an arm's own list price: tokens plus 0.005 USD a Parallel call. */
export function listPriceUsd(spend, priceIn, priceOut) {
  return (count(spend.inputTokens) * priceIn + count(spend.outputTokens) * priceOut) / 1e6 + count(spend.parallelCalls) * PARALLEL_SEARCH_USD;
}

/** Parallel's advanced search fee per request (packages/api/src/store/consensus-cost.ts). */
export const PARALLEL_SEARCH_USD = 0.005;

function buildRow(item, result, attempts, engineSha, arm = 'google', spent = emptySpend(), label = undefined) {
  return {
    id: item.id,
    arm: label ?? arm,
    ...(label === undefined ? {} : { grounding: arm }),
    gold: item.gold,
    status: result ? result.status : 'unverified',
    // The verdict label (the same value as status), named for the arm comparison.
    verdict: result ? result.status : 'unverified',
    sourcesCount: result ? count(result.sourcesCount) : 0,
    // Summed over every call made for this item, retries included: what the item cost.
    costUsd: spent.costUsd,
    googleGroundingCalls: spent.googleGroundingCalls,
    inputTokens: count(spent.inputTokens),
    outputTokens: count(spent.outputTokens),
    parallelCalls: count(spent.parallelCalls),
    apiError: result ? result.apiError === true : true,
    parseFallback: result ? result.parseFallback === true : false,
    noSourceAbstain: result ? result.noSourceAbstain === true : false,
    // The judge said the sources do not address the claim (GoPMO 1.18.11.7.19): an unverified
    // row the summary counts as not checkable.
    notCheckable: result ? result.notCheckable === true : false,
    // Why an unchecked item went unchecked (output_truncated, provider_unparseable, ...): a label,
    // never text. It lets a readout separate a binding ceiling from other failures (GoPMO 1.18.11.7.18).
    apiErrorReason: result && typeof result.apiErrorReason === 'string' && /^[a-z_]{1,40}$/.test(result.apiErrorReason) ? result.apiErrorReason : null,
    attempts,
    model: result && typeof result.model === 'string' ? result.model : null,
    judgeModel: result && typeof result.judgeModel === 'string' ? result.judgeModel : null,
    engineSha,
    ts: new Date().toISOString(),
  };
}

/**
 * Run the batches. Rows are appended as soon as an item is final, so a stop at
 * any point leaves a file `--resume` can continue from the next unanswered id.
 */
function appendRows(file, rows) {
  if (rows.length > 0) appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

/**
 * Items whose ledger already holds MAX_CALLS calls get no fifth call: they are
 * written as failures with attempts = MAX_CALLS, the calls actually made.
 */
function closeExhausted(pending, attempts, options, engine, log, spent = new Map()) {
  const exhausted = pending.filter((item) => (attempts.get(item.id) ?? 0) >= MAX_CALLS);
  appendRows(options.out, exhausted.map((item) => buildRow(item, null, MAX_CALLS, engine.engineSha, options.runArm,
    spent.get(item.id) ?? emptySpend(), options.label)));
  if (exhausted.length > 0) log(`${exhausted.length} item(s) already had ${MAX_CALLS} calls in the ledger: written as failures, not called again`);
  return pending.filter((item) => (attempts.get(item.id) ?? 0) < MAX_CALLS);
}

async function runBatches({ request, allowance, options, pending, engine, done, attempts, log }) {
  let model = [...done.values()].find((row) => row.model)?.model ?? null;
  const arm = options.runArm ?? 'google';
  const spendFile = spendPath(options.out);
  // Restored before closeExhausted, so an item that used all its calls before a stop keeps what they cost.
  const spent = readSpend(spendFile, arm);
  const queue = closeExhausted(pending, attempts, options, engine, log, spent);
  const total = done.size + pending.length;
  const ledger = ledgerPath(options.out);
  let retryRound = 0;
  while (queue.length > 0) {
    const batch = queue.splice(0, BATCH_SIZE);
    await guardAllowance(allowance, batch.length, log);
    await guardEngine(request, engine);
    const calls = batch.map((item) => ({ id: item.id, attempt: (attempts.get(item.id) ?? 0) + 1 }));
    recordCalls(ledger, calls, arm);
    for (const { id, attempt } of calls) attempts.set(id, attempt);
    const inBatch = new Set(batch.map((item) => item.id));
    const onAnswer = (answers) => {
      const spendRows = [];
      const counted = new Set();
      for (const answer of answers) {
        const id = Number(answer?.id);
        if (!inBatch.has(id) || counted.has(id)) continue;
        counted.add(id);
        const costUsd = count(answer?.usage?.costUsd);
        const googleGroundingCalls = count(answer?.usage?.googleGroundingCalls);
        const inputTokens = count(answer?.usage?.inputTokens);
        const outputTokens = count(answer?.usage?.outputTokens);
        // Every search the claim made that was not a Google grounded call is a Parallel search here.
        const parallelCalls = Math.max(0, count(answer?.usage?.groundingCalls) - googleGroundingCalls);
        spendRows.push({ id, arm, attempt: attempts.get(id), costUsd, googleGroundingCalls, inputTokens, outputTokens, parallelCalls });
        const so = spent.get(id) ?? emptySpend();
        so.costUsd += costUsd;
        so.googleGroundingCalls += googleGroundingCalls;
        so.inputTokens += inputTokens;
        so.outputTokens += outputTokens;
        so.parallelCalls += parallelCalls;
        spent.set(id, so);
      }
      recordSpend(spendFile, spendRows);
    };
    const results = await postBatch(request, batch, allowance.length > 1, arm, onAnswer);
    const rows = [];
    const retry = [];
    for (const item of batch) {
      const result = results?.get(item.id) ?? null;
      const tries = attempts.get(item.id);
      const so = spent.get(item.id) ?? emptySpend();
      const failed = !result || result.apiError === true;
      if (!failed && options.judgeModel !== undefined && result.judgeModel !== options.judgeModel) {
        throw new RunStop(EXIT.INVALID, `INVALID: item ${item.id} was judged by ${result.judgeModel ?? 'an unnamed model'}, not ${options.judgeModel}. Stop; do not score.`);
      }
      if (failed && tries < MAX_CALLS) retry.push(item);
      else rows.push(buildRow(item, result, tries, engine.engineSha, arm, so, options.label));
    }
    appendRows(options.out, rows);
    guardListPrice(options, spent, done, rows, total, log);
    log(`batch ${batch[0].id}..${batch[batch.length - 1].id}: ${rows.length} written, ${retry.length} to retry`);
    const seen = [...new Set(rows.map((row) => row.model).filter(Boolean))];
    for (const current of seen) {
      if (model && current !== model) {
        throw new RunStop(EXIT.INVALID, `INVALID (prereg §5): engine model changed during the run (${model} -> ${current}). Stop; do not score.`);
      }
      model ??= current;
    }
    if (retry.length > 0) {
      retryRound += 1;
      await sleep(options.retryBaseMs * 2 ** Math.min(retryRound - 1, 5));
      queue.unshift(...retry);
    } else {
      retryRound = 0;
    }
  }
}

/**
 * The judge A/B cost guard (prereg section 9): once the arm has 25 written claims, project
 * its whole cost at its own list price and stop when that would pass --cap-usd.
 */
const COST_GUARD_AFTER = 25;
export function projectedArmUsd(spentByItem, written, total, priceIn, priceOut) {
  if (written === 0) return 0;
  let usd = 0;
  for (const so of spentByItem.values()) usd += listPriceUsd(so, priceIn, priceOut);
  return (usd / written) * total;
}

function guardListPrice(options, spent, done, rows, total, log) {
  if (options.capUsd === undefined) return;
  for (const row of rows) done.set(row.id, row);
  if (done.size < COST_GUARD_AFTER) return;
  const projected = projectedArmUsd(spent, done.size, total, options.priceIn, options.priceOut);
  log(`list-price projection: ${projected.toFixed(4)} USD for ${total} claims (cap ${options.capUsd})`);
  if (projected > options.capUsd) {
    throw new RunStop(EXIT.SPEND_CAP, `STOP (prereg section 9): projected ${projected.toFixed(4)} USD at list price passes the ${options.capUsd} USD cap`);
  }
}

function summarize(file, expected, log) {
  const rows = [...readDone(file).values()];
  const failures = rows.filter((row) => row.apiError).length;
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  log(`done: ${rows.length}/${expected} items, statuses ${JSON.stringify(counts)}, failures ${failures}`);
  if (failures > Math.floor(expected * 0.02)) {
    log(`WARNING: ${failures} failures exceed 2% of ${expected}; the scorer will mark the run INVALID (prereg §5).`);
  }
}

/**
 * Every arm --arm names, in turn, on the same items, then the summary. Each arm
 * is one runArm call with its own out file and attempt ledger; a stop in any arm
 * ends the run with that arm's exit code (resumable with --resume, which resumes
 * every arm's file). The summary is written by the scorer's --arms mode.
 */
export async function runAccuracy(options, deps = {}) {
  const log = deps.log ?? ((line) => writeLine(process.stdout, line));
  const arms = armsOf(options.arm ?? 'google');
  const outs = [];
  for (const arm of arms) {
    const out = armOut(options, arm);
    log(`arm ${arm}: out ${out}`);
    const code = await runArm({ ...options, out, runArm: arm }, { ...deps, log });
    if (code !== EXIT.OK) return code;
    outs.push(out);
  }
  return writeSummary(options, outs, deps.summarize ?? runScorerArms, log);
}

/** The scorer's --arms mode over the arm files; writes `<base>.summary.json`. */
function runScorerArms(outs, summary) {
  const scorer = path.join(REPO_ROOT, 'scripts/accuracy-g0-score.py');
  const result = spawnSync('python3', [scorer, '--arms', ...outs, '--json', summary], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function writeSummary(options, outs, summarizeArms, log) {
  const summary = summaryPath(options);
  const { status, output } = summarizeArms(outs, summary);
  for (const line of String(output).split('\n')) if (line.trim()) log(line);
  // The arm files are the run's result; the summary is derived from them at $0 and can be
  // written again, so a scorer that cannot run (no python3 or numpy) does not fail the run.
  if (status !== 0) {
    log(`WARNING: the arm summary was not written (scorer exit ${status}). Write it with: `
      + `python3 scripts/accuracy-g0-score.py --arms ${outs.join(' ')} --json ${summary}`);
    return EXIT.OK;
  }
  log(`summary ${summary}`);
  return EXIT.OK;
}

/**
 * One arm. `deps.log` receives progress lines; nothing it receives ever
 * contains the key, because the key only ever goes into a request header.
 */
async function runArm(options, deps = {}) {
  const log = deps.log ?? ((line) => writeLine(process.stdout, line));
  const picked = deps.key !== undefined ? { key: deps.key, labelled: true } : readRunKey(deps.env ?? process.env);
  const key = picked.key;
  try {
    const actual = sha256File(options.gold);
    if (actual !== GOLD_SHA256) {
      throw new RunStop(EXIT.REFUSED, `REFUSED (prereg §2): gold sha256 ${actual} is not ${GOLD_SHA256}`);
    }
    if (!key) {
      throw new RunStop(EXIT.REFUSED, 'REFUSED: no measurement or admin key (set FAULTLINE_MEASUREMENT_KEY or ~/.config/faultline/measurement-key.env; '
        + 'unlabelled fallback: FAULTLINE_ADMIN_KEY or ~/.config/faultline/hosted-api-key.env)');
    }
    if (!picked.labelled) log(UNLABELLED_WARNING);
    const selected = selectItems(options.set, loadGold(options.gold), options.subsample);
    const items = options.sample !== undefined ? seededSample(selected, options.sample, options.seed) : selected;
    if (options.sample !== undefined) log(`sample ${items.length} of ${selected.length} items, seed ${options.seed}`);
    const ledger = ledgerPath(options.out);
    if (!options.resume && (existsSync(options.out) || existsSync(ledger) || existsSync(spendPath(options.out)))) {
      throw new RunStop(EXIT.REFUSED, `REFUSED: ${options.out} or its attempt ledger exists, or its spend ledger exists; pass --resume to continue it`);
    }
    mkdirSync(path.dirname(options.out), { recursive: true });
    const done = readDone(options.out);
    const allowed = new Set(items.map((item) => item.id));
    // With --label the rows carry the label as their arm name.
    const runArmName = options.label ?? options.runArm ?? 'google';
    const otherArm = [...done.values()].find((row) => (row.arm ?? 'google') !== runArmName);
    if (otherArm) {
      throw new RunStop(EXIT.REFUSED, `REFUSED: ${options.out} holds rows from arm ${otherArm.arm ?? 'google'}, not ${runArmName}`);
    }
    if ([...done.keys()].some((id) => !allowed.has(id))) {
      throw new RunStop(EXIT.REFUSED, `REFUSED: ${options.out} holds ids outside the ${options.set} set`);
    }
    const request = makeClient(options.api, key);
    const engine = await resolveEngine(request, options, done);
    const attempts = readLedger(ledger, options.runArm ?? 'google');
    if (done.size > 0 && !existsSync(ledger)) {
      throw new RunStop(EXIT.REFUSED, `REFUSED: ${options.out} has rows but no attempt ledger (${ledger}); the call counts cannot be restored`);
    }
    const pending = items.filter((item) => !done.has(item.id));
    log(`set ${options.set}: ${items.length} items, ${done.size} already written, ${pending.length} to run; engine ${engine.engineSha}; out ${options.out}`);
    const allowance = [request, ...(options.allowanceApi ? [makeClient(options.allowanceApi, key)] : [])];
    await runBatches({ request, allowance, options, pending, engine, done, attempts, log });
    summarize(options.out, items.length, log);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof RunStop) {
      log(error.message);
      return error.exitCode;
    }
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.ERROR;
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeLine(process.stderr, `REFUSED: ${error.message}`);
    return EXIT.REFUSED;
  }
  return runAccuracy(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
