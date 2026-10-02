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
 *        [--api <url>] [--out <path>] [--resume] [--engine-sha <sha>]
 *
 * Guards (each is a prereg rule, not a tunable):
 *   - the gold file must hash to GOLD_SHA256, else nothing is sent   (§2, §5)
 *   - before the run and before every batch, GET /usage: stop if today's
 *     grounded prompts + the batch would pass 1,000                  (§7)
 *   - apiError items are retried up to 3 times with backoff          (§6)
 *   - the engine model or commit changing mid-run stops the run      (§5)
 *
 * The admin key comes from FAULTLINE_ADMIN_KEY, else the FAULTLINE_API_KEY= line
 * of ~/.config/faultline/hosted-api-key.env. It is sent as x-api-key and never
 * printed.
 *
 * Exit codes:
 *   0 all items answered        2 refused before sending anything (hash, args,
 *   1 error (HTTP/protocol)       key, engine identity)
 *   3 grounding allowance guard stop, resumable with --resume
 *   4 INVALID run: model or engine commit changed (prereg §5)
 *   5 provider-spend cap reached (503), resumable with --resume
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
/** Prereg §6: the route takes up to 25 claims. */
export const BATCH_SIZE = 25;
/** Prereg §6: retry any apiError item up to 3 times. */
export const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
/** Fixed location of the hosted admin key; never derived from input. */
const KEY_FILE = `${homedir()}/.config/faultline/hosted-api-key.env`;

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

export function parseArgs(argv) {
  const options = {
    set: undefined, api: DEFAULT_API, out: undefined, resume: false, engineSha: undefined,
    gold: GOLD_PATH, subsample: SUBSAMPLE_PATH, retryBaseMs: 2000,
  };
  const valueFlags = {
    '--set': 'set', '--api': 'api', '--out': 'out', '--engine-sha': 'engineSha',
    '--gold': 'gold', '--subsample': 'subsample', '--retry-base-ms': 'retryBaseMs',
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
  options.retryBaseMs = Number(options.retryBaseMs);
  if (!Number.isFinite(options.retryBaseMs) || options.retryBaseMs < 0) throw new Error('--retry-base-ms must be >= 0');
  options.api = options.api.replace(/\/+$/, '');
  if (options.engineSha !== undefined) options.engineSha = normalizeSha(options.engineSha);
  options.out ??= path.join(REPO_ROOT, 'docs/research/data', `accuracy-g0-${defaultRunId(options.set)}.jsonl`);
  return options;
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

/** The admin key, from env or the hosted-api-key file. Never logged. */
export function readAdminKey(env = process.env, file = KEY_FILE) {
  const fromEnv = (env.FAULTLINE_ADMIN_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?FAULTLINE_API_KEY\s*=\s*(.*)$/.exec(line);
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
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

// ── HTTP ─────────────────────────────────────────────────────────────────────

function makeClient(api, key) {
  return async function request(method, route, body) {
    const response = await fetch(`${api}${route}`, {
      method,
      headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
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

async function readGroundedPrompts(request) {
  const { status, json } = await request('GET', '/usage');
  const count = json?.groundingAllowance?.groundedPrompts;
  if (status !== 200 || typeof count !== 'number') {
    throw new RunStop(EXIT.ERROR, `GET /usage answered ${status} without groundingAllowance.groundedPrompts (is the key the admin key?)`);
  }
  return { count, day: json.groundingAllowance.day, resetsAt: json.groundingAllowance.resetsAt };
}

// ── Guards ───────────────────────────────────────────────────────────────────

/** Prereg §7: stop before a batch that would take today's count past 1,000. */
async function guardAllowance(request, batchSize, log) {
  const allowance = await readGroundedPrompts(request);
  if (allowance.count + batchSize > DAILY_GROUNDED_CAP) {
    throw new RunStop(
      EXIT.ALLOWANCE_STOP,
      `STOP (allowance guard): ${allowance.count} grounded prompts on ${allowance.day} + batch of ${batchSize} would pass ${DAILY_GROUNDED_CAP}. `
        + `Resume after ${allowance.resetsAt} with --resume.`,
    );
  }
  log(`allowance ${allowance.count}/${DAILY_GROUNDED_CAP} on ${allowance.day}`);
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
async function postBatch(request, batch) {
  let response;
  try {
    response = await request('POST', '/admin/verify-claims', {
      claims: batch.map((item) => ({ id: String(item.id), text: item.claim })),
    });
  } catch {
    return null; // network error or timeout: every item in the batch is an apiError attempt
  }
  const { status, json } = response;
  if (status === 503 && /budget/i.test(String(json?.error ?? ''))) {
    throw new RunStop(EXIT.SPEND_CAP, 'STOP: the provider-spend cap is exhausted (503). Resume with --resume after the budget resets.');
  }
  if (status === 401 || status === 403) throw new RunStop(EXIT.ERROR, `the API refused the admin key (${status})`);
  if (status === 400 || (status === 503 && json?.error === 'provider_not_configured')) {
    throw new RunStop(EXIT.ERROR, `the API rejected the batch (${status} ${json?.error ?? ''})`);
  }
  if (status !== 200 || !Array.isArray(json?.results)) return null;
  const byId = new Map(json.results.map((result) => [Number(result.id), result]));
  if (byId.size !== batch.length || batch.some((item) => !byId.has(item.id))) {
    throw new RunStop(EXIT.ERROR, 'protocol error: the response ids do not match the batch');
  }
  return byId;
}

function buildRow(item, result, attempts, engineSha) {
  return {
    id: item.id,
    gold: item.gold,
    status: result ? result.status : 'unverified',
    apiError: result ? result.apiError === true : true,
    parseFallback: result ? result.parseFallback === true : false,
    attempts,
    model: result && typeof result.model === 'string' ? result.model : null,
    engineSha,
    ts: new Date().toISOString(),
  };
}

/**
 * Run the batches. Rows are appended as soon as an item is final, so a stop at
 * any point leaves a file `--resume` can continue from the next unanswered id.
 */
async function runBatches({ request, options, pending, engine, done, log }) {
  let model = [...done.values()].find((row) => row.model)?.model ?? null;
  const attempts = new Map();
  const queue = [...pending];
  let retryRound = 0;
  while (queue.length > 0) {
    const batch = queue.splice(0, BATCH_SIZE);
    await guardAllowance(request, batch.length, log);
    await guardEngine(request, engine);
    const results = await postBatch(request, batch);
    const rows = [];
    const retry = [];
    for (const item of batch) {
      const result = results?.get(item.id) ?? null;
      const tries = (attempts.get(item.id) ?? 0) + 1;
      attempts.set(item.id, tries);
      const failed = !result || result.apiError === true;
      if (failed && tries <= MAX_RETRIES) retry.push(item);
      else rows.push(buildRow(item, result, tries, engine.engineSha));
    }
    if (rows.length > 0) appendFileSync(options.out, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
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
 * The whole run. `deps.log` receives progress lines; nothing it receives ever
 * contains the key, because the key only ever goes into a request header.
 */
export async function runAccuracy(options, deps = {}) {
  const log = deps.log ?? ((line) => writeLine(process.stdout, line));
  const key = deps.key ?? readAdminKey();
  try {
    const actual = sha256File(options.gold);
    if (actual !== GOLD_SHA256) {
      throw new RunStop(EXIT.REFUSED, `REFUSED (prereg §2): gold sha256 ${actual} is not ${GOLD_SHA256}`);
    }
    if (!key) throw new RunStop(EXIT.REFUSED, 'REFUSED: no admin key (set FAULTLINE_ADMIN_KEY or ~/.config/faultline/hosted-api-key.env)');
    const items = selectItems(options.set, loadGold(options.gold), options.subsample);
    if (!options.resume && existsSync(options.out)) {
      throw new RunStop(EXIT.REFUSED, `REFUSED: ${options.out} exists; pass --resume to continue it`);
    }
    mkdirSync(path.dirname(options.out), { recursive: true });
    const done = readDone(options.out);
    const allowed = new Set(items.map((item) => item.id));
    if ([...done.keys()].some((id) => !allowed.has(id))) {
      throw new RunStop(EXIT.REFUSED, `REFUSED: ${options.out} holds ids outside the ${options.set} set`);
    }
    const request = makeClient(options.api, key);
    const engine = await resolveEngine(request, options, done);
    const pending = items.filter((item) => !done.has(item.id));
    log(`set ${options.set}: ${items.length} items, ${done.size} already written, ${pending.length} to run; engine ${engine.engineSha}; out ${options.out}`);
    await runBatches({ request, options, pending, engine, done, log });
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
