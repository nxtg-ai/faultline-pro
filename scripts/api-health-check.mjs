#!/usr/bin/env node
// Validates: GoPMO 1.18.7.3.2 (alerting fires on a hosted-API failure)
/**
 * Five-minute health check of the hosted Faultline API. See
 * docs/api-health-alert.md.
 *
 * GETs <url> (default https://faultline-api.fly.dev/health) with a 10 s
 * timeout, up to 3 attempts 20 s apart. The API is down when every attempt
 * times out, fails on the network, returns a non-200, or returns a body whose
 * `status` is not "ok". /health needs no key, so this script reads none.
 *
 *   - one Telegram alert per incident (state file remembers it is down),
 *   - one Telegram recovery message when it comes back,
 *   - one log line per run: ISO time, url, http code, latency, verdict.
 *
 * Exit: 0 healthy, 1 down.
 * Env: FAULTLINE_HEALTH_URL, FAULTLINE_HEALTH_STATE_FILE,
 * FAULTLINE_HEALTH_ALERT_PREFIX (e.g. "TEST", put in front of every message),
 * FAULTLINE_HEALTH_NOTIFY (notifier path, default notify-telegram.sh).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_URL = 'https://faultline-api.fly.dev/health';
export const DEFAULT_STATE_FILE = join(homedir(), '.cache', 'faultline-pro', 'api-health-state.json');
const DEFAULT_NOTIFY = join(homedir(), 'ASIF', 'scripts', 'notify-telegram.sh');

export function loadState(stateFile) {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    return s && (s.status === 'up' || s.status === 'down') ? s : { status: 'up' };
  } catch {
    return { status: 'up' };
  }
}

export function saveState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Send one Telegram line. execFile, not a shell: `$` and backticks stay literal.
 * The notifier's stdout ("Telegram: sent") is printed so the log shows delivery.
 */
export function makeNotify(notifyPath = DEFAULT_NOTIFY) {
  return (message) => {
    try {
      const out = execFileSync(notifyPath, [message], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
      const text = out.toString().trim();
      if (text) console.log(text);
      return true;
    } catch (error) {
      console.error(`notify failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
}

/** One GET. Returns { ok, code, latencyMs, reason }. Never throws. */
export async function probeOnce(url, fetchImpl, timeoutMs, now) {
  const started = now();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = now() - started;
    if (res.status !== 200) return { ok: false, code: res.status, latencyMs, reason: `HTTP ${res.status}` };
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, code: 200, latencyMs, reason: 'body is not JSON' };
    }
    if (body?.status !== 'ok') {
      return { ok: false, code: 200, latencyMs, reason: `body.status is ${JSON.stringify(body?.status)}, not "ok"` };
    }
    return { ok: true, code: 200, latencyMs, reason: 'ok', version: body.version, stage: body.stage };
  } catch (error) {
    const latencyMs = now() - started;
    const name = error?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, code: 'timeout', latencyMs, reason: `timeout after ${timeoutMs} ms` };
    }
    const msg = error instanceof Error ? (error.cause?.code ?? error.message) : String(error);
    return { ok: false, code: 'error', latencyMs, reason: `network error: ${msg}` };
  }
}

/**
 * Run one check. All side effects are injected so tests never touch the
 * network, Telegram or the real state file.
 * Returns { exitCode, state, notified, line, attempts }.
 */
export async function runHealthCheck({
  url = DEFAULT_URL,
  stateFile = DEFAULT_STATE_FILE,
  fetch: fetchImpl = globalThis.fetch,
  notify = makeNotify(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  timeoutMs = 10_000,
  retries = 2,
  retryDelayMs = 20_000,
  alertPrefix = '',
  log = console.log,
} = {}) {
  const attempts = [];
  let result;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(retryDelayMs);
    result = await probeOnce(url, fetchImpl, timeoutMs, now);
    attempts.push(result);
    if (result.ok) break;
  }

  const prefix = alertPrefix ? `${alertPrefix} ` : '';
  const isoNow = new Date(now()).toISOString();
  const prev = loadState(stateFile);
  let state = prev;
  let notified = false;

  if (!result.ok) {
    if (prev.status !== 'down' || !prev.alertedAt) {
      // New incident (or the first alert for it failed to send): alert once.
      notified = notify(
        `${prefix}Faultline hosted API DOWN: ${url} failed ${attempts.length} of ${attempts.length} attempts. `
        + `Last: ${result.reason} (code ${result.code}, ${result.latencyMs} ms) at ${isoNow}.`,
      );
      state = {
        status: 'down',
        since: prev.status === 'down' ? prev.since : isoNow,
        alertedAt: notified ? isoNow : null,
        lastReason: result.reason,
      };
    } else {
      state = { ...prev, lastReason: result.reason };
    }
  } else if (prev.status === 'down') {
    const downMin = prev.since ? Math.round((now() - Date.parse(prev.since)) / 60_000) : null;
    notified = notify(
      `${prefix}Faultline hosted API RECOVERED: ${url} is 200 status ok again `
      + `(version ${result.version ?? '?'}, ${result.latencyMs} ms) at ${isoNow}.`
      + `${downMin !== null ? ` Down about ${downMin} min since ${prev.since}.` : ''}`,
    );
    // Stay 'down' if the recovery message failed, so the next run retries it.
    state = notified ? { status: 'up', since: isoNow } : prev;
  } else {
    state = { status: 'up', since: prev.since ?? isoNow };
  }

  saveState(stateFile, state);
  const verdict = result.ok ? 'UP' : 'DOWN';
  const line = `${isoNow} ${verdict} url=${url} code=${result.code} latency_ms=${result.latencyMs} `
    + `attempts=${attempts.length}${result.ok ? '' : ` reason="${result.reason}"`} notified=${notified}`;
  log(line);
  return { exitCode: result.ok ? 0 : 1, state, notified, line, attempts };
}

async function main() {
  const { exitCode } = await runHealthCheck({
    url: process.env.FAULTLINE_HEALTH_URL || DEFAULT_URL,
    stateFile: process.env.FAULTLINE_HEALTH_STATE_FILE || DEFAULT_STATE_FILE,
    notify: makeNotify(process.env.FAULTLINE_HEALTH_NOTIFY || DEFAULT_NOTIFY),
    alertPrefix: (process.env.FAULTLINE_HEALTH_ALERT_PREFIX ?? '').trim(),
  });
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`api-health-check crashed: ${error instanceof Error ? error.stack : String(error)}`);
      process.exit(1);
    },
  );
}
