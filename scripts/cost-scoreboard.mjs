#!/usr/bin/env node
/**
 * scripts/cost-scoreboard.mjs — the weekly cost scoreboard.
 *
 * Calls GET /admin/cost-summary on the hosted API, writes the JSON response to
 * the path given by --out, and prints one summary line: the window and the cost
 * per billed customer claim (customer costUsd / customerBilledClaims), or "n/a"
 * when no customer claim was billed.
 *
 * The admin key comes from FAULTLINE_API_KEY, else the FAULTLINE_API_KEY= line of
 * ~/.config/faultline/hosted-api-key.env. It is sent only as the x-api-key header
 * and never printed, written or logged.
 *
 * Usage:
 *   node scripts/cost-scoreboard.mjs --out cost-week.json [--api https://faultline-api.fly.dev]
 *     [--from 2026-10-19T00:00:00Z] [--to 2026-10-26T00:00:00Z]
 * With no --from/--to the API reports the last complete Monday-to-Monday week (UTC).
 * Exit codes: 0 written, 1 the request failed, 2 bad arguments or no key.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_API = 'https://faultline-api.fly.dev';
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2 });
/** Fixed location of the hosted admin key; never derived from input. */
export const KEY_FILE = `${homedir()}/.config/faultline/hosted-api-key.env`;

export class UsageError extends Error {}

const KEY_LINE = /^\s*(?:export\s+)?FAULTLINE_API_KEY\s*=\s*(.*)$/;

/** The admin key from env, else the key file, else ''. Never logged. */
export function readAdminKey(env = process.env, file = KEY_FILE) {
  const fromEnv = (env.FAULTLINE_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = KEY_LINE.exec(line);
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}

export function parseArgs(argv) {
  const opts = { api: DEFAULT_API, out: undefined, from: undefined, to: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = ['--api', '--out', '--from', '--to'].find((f) => arg === f);
    if (!flag) throw new UsageError(`unknown argument: ${arg}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    opts[flag.slice(2)] = value;
  }
  if (!opts.out) throw new UsageError('--out <path> is required');
  return opts;
}

/** The request URL for the options. */
export function summaryUrl(opts) {
  const url = new URL('/admin/cost-summary', opts.api);
  if (opts.from) url.searchParams.set('from', opts.from);
  if (opts.to) url.searchParams.set('to', opts.to);
  return url.toString();
}

/** Cost per billed customer claim in USD, or null when none was billed. */
export function costPerBilledClaim(summary) {
  const billed = Number(summary?.customerBilledClaims ?? 0);
  const cost = Number(summary?.classes?.customer?.costUsd ?? 0);
  if (!Number.isFinite(billed) || billed <= 0 || !Number.isFinite(cost)) return null;
  return cost / billed;
}

/** The one summary line. It holds no key. */
export function summaryLine(summary) {
  const per = costPerBilledClaim(summary);
  const perText = per === null ? 'n/a' : `$${per.toFixed(4)}`;
  const billed = Number(summary?.customerBilledClaims ?? 0);
  const cost = Number(summary?.classes?.customer?.costUsd ?? 0);
  return `cost-scoreboard ${summary.from} to ${summary.to}: cost per billed customer claim ${perText} `
    + `(customer cost $${cost.toFixed(4)}, billed claims ${billed})`;
}

/**
 * Fetch the summary, write it to opts.out, print the line. `deps` lets tests
 * stub fetch, the key, the writer and the output streams.
 */
export async function run(argv, deps = {}) {
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line) => process.stderr.write(`${line}\n`));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`cost-scoreboard: ${e.message}`);
      return EXIT.USAGE;
    }
    throw e;
  }
  const key = deps.key ?? readAdminKey(deps.env ?? process.env, deps.keyFile ?? KEY_FILE);
  if (!key) {
    err('cost-scoreboard: no admin key (set FAULTLINE_API_KEY or ~/.config/faultline/hosted-api-key.env)');
    return EXIT.USAGE;
  }
  const doFetch = deps.fetch ?? globalThis.fetch;
  let res;
  try {
    res = await doFetch(summaryUrl(opts), { method: 'GET', headers: { 'x-api-key': key, accept: 'application/json' } });
  } catch {
    // The error's own text is not printed: it could echo request details.
    err('cost-scoreboard: request failed (network error)');
    return EXIT.ERROR;
  }
  if (!res.ok) {
    err(`cost-scoreboard: GET /admin/cost-summary answered HTTP ${res.status}`);
    return EXIT.ERROR;
  }
  const summary = await res.json();
  const write = deps.writeFile ?? ((file, text) => writeFileSync(file, text));
  write(path.resolve(opts.out), `${JSON.stringify(summary, null, 2)}\n`);
  log(summaryLine(summary));
  return EXIT.OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
