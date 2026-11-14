#!/usr/bin/env node
// Validates: GoPMO 1.18.11.7.127 (ruling Dx3 abccffac item 4)
/**
 * Daily check of which Gemini model judged production's claims. Reads the admin block
 * `judgeModels` of GET <api>/usage: per-model judge calls over the last 7 UTC days and the share
 * the fallback judge made. When that share is above 10% (the server's `alert`), it wakes the lane
 * that runs Faultline and the program owner once per UTC day: one alignment post that wakes the
 * owner, and a paste into the Faultline lane's tmux pane (a post by that lane cannot wake its own
 * pane). That is the signal to price a higher Google tier for the primary judge.
 *
 * No model is called. The key is the server key (FAULTLINE_API_KEY from env, else the web app's
 * .env.local); it goes only into the x-api-key header and is never printed.
 *
 * Exit: 0 OK, 1 ALERT, 2 probe failure.
 * Env: FAULTLINE_API_URL, FAULTLINE_API_KEY, JUDGE_STATE_DIR, JUDGE_MONITOR_LOG,
 * JUDGE_ALIGNMENT_SAY (the post command; '' turns the post off), JUDGE_WAKE (the lane the post wakes,
 * default emma-soul), FP_TMUX_TARGET (default faultline-pro:1.1; '' turns the pane paste off).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = homedir();
const ENV_FILE = join(HOME, 'projects', 'faultline-web', '.env.local');

export function readApiKey(env = process.env, envFile = ENV_FILE) {
  const fromEnv = (env.FAULTLINE_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(envFile)) return '';
  const line = readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith('FAULTLINE_API_KEY='));
  return line ? line.slice('FAULTLINE_API_KEY='.length).trim().replace(/^["']|["']$/g, '') : '';
}

/** A key that can go into a header: printable ASCII, no spaces. Anything else is refused, never sent. */
export function isUsableKey(key) {
  return /^[\x21-\x7e]{8,512}$/.test(key);
}

/** An error message with any copy of the key removed. */
export function redact(message, key) {
  return key ? String(message).split(key).join('[key]') : String(message);
}

/** The one line a run reports, from the server's judgeModels block. */
export function summarize(block) {
  const models = Object.entries(block.byModel ?? {}).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', ') || 'none';
  const share = block.fallbackShare === null || block.fallbackShare === undefined ? 'n/a' : `${(block.fallbackShare * 100).toFixed(1)}%`;
  return `judge calls ${block.from} to ${block.to}: ${block.total} (${models}); fallback share ${share} vs ${(block.alertShare * 100).toFixed(0)}% alert line; primary ${block.primary}`;
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

/** Validate the block; a missing or malformed one is a probe failure, never an OK. */
export function readBlock(json) {
  const b = json?.judgeModels;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('no judgeModels block on /usage (wrong key, or a server without the counter)');
  const byModel = b.byModel;
  const okByModel = byModel !== null && typeof byModel === 'object' && !Array.isArray(byModel) && Object.values(byModel).every(isCount);
  const sum = okByModel ? Object.values(byModel).reduce((s, n) => s + n, 0) : -1;
  const okShare = b.total === 0 ? b.fallbackShare === null : typeof b.fallbackShare === 'number' && b.fallbackShare >= 0 && b.fallbackShare <= 1;
  if (!okByModel || !isCount(b.total) || sum !== b.total || !isCount(b.fallbackCalls) || b.fallbackCalls > b.total || !okShare
    || typeof b.alert !== 'boolean' || typeof b.alertShare !== 'number' || typeof b.primary !== 'string' || b.primary === '') {
    throw new Error('judgeModels block is malformed');
  }
  // The alert is recomputed here, so a server bug that drops it cannot read as OK.
  const alert = b.fallbackShare !== null && b.fallbackShare > b.alertShare;
  if (alert !== b.alert) throw new Error('judgeModels alert disagrees with its own share');
  return b;
}

/** Which of today's two deliveries already went out: { posted, pasted }. Each is retried until it does. */
export function deliveredToday(stateFile, day) {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    return s.day === day ? { posted: s.posted === true, pasted: s.pasted === true } : { posted: false, pasted: false };
  } catch {
    return { posted: false, pasted: false };
  }
}

export function markDelivered(stateFile, day, delivered) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ day, ...delivered }) + '\n');
}

export function alertPost(block, wake) {
  const mentions = wake.map((l) => `@${l}`).join(' ');
  return `${mentions} JUDGE FALLBACK ALERT, GoPMO 1.18.11.7.127 item 4 (fp is woken in its pane). `
    + `The fallback judge made more than ${(block.alertShare * 100).toFixed(0)}% of production's judge calls over the last 7 days. `
    + `Instrument: admin GET /usage judgeModels -> ${summarize(block)}. That is the signal to price a higher Google tier for ${block.primary}.`;
}

export async function main({
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
  log = (line) => { process.stdout.write(`${line}\n`); },
  post = null,
  pane = null,
} = {}) {
  const api = (env.FAULTLINE_API_URL ?? 'https://faultline-api.fly.dev').replace(/\/+$/, '');
  const stateFile = join(env.JUDGE_STATE_DIR ?? join(HOME, '.cache', 'faultline-pro'), 'judge-fallback-state.json');
  const monitorLog = env.JUDGE_MONITOR_LOG ?? join(HOME, 'ASIF', 'governance', 'spend-monitor', 'faultline-pro-judge-models.jsonl');
  const sayCmd = env.JUDGE_ALIGNMENT_SAY ?? join(HOME, 'ASIF', 'scripts', 'alignment-say');
  const wake = (env.JUDGE_WAKE ?? 'emma-soul').split(/\s+/).filter(Boolean);
  const paneTarget = env.FP_TMUX_TARGET ?? 'faultline-pro:1.1';
  const day = now.toISOString().slice(0, 10);
  const key = readApiKey(env);
  const record = (row) => {
    try {
      mkdirSync(dirname(monitorLog), { recursive: true });
      appendFileSync(monitorLog, JSON.stringify({ ts: now.toISOString(), ...row }) + '\n');
    } catch {
      // The monitor row is a convenience; the exit code is the result.
    }
  };
  if (!key) {
    log('PROBE FAILURE: no server key (FAULTLINE_API_KEY or the web app .env.local)');
    record({ status: 'probe_failure', reason: 'no key' });
    return 2;
  }
  if (!isUsableKey(key)) {
    log('PROBE FAILURE: the server key is malformed (it holds a space, a control character or a non-ASCII character); not sent');
    record({ status: 'probe_failure', reason: 'malformed key' });
    return 2;
  }
  let block;
  try {
    const res = await fetchImpl(`${api}/usage`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 200) throw new Error(`/usage answered ${res.status}`);
    block = readBlock(await res.json());
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err), key).slice(0, 160);
    log(`PROBE FAILURE: ${reason}`);
    record({ status: 'probe_failure', reason });
    return 2;
  }
  record({ status: block.alert ? 'alert' : 'ok', total: block.total, byModel: block.byModel, fallbackShare: block.fallbackShare, primary: block.primary });
  if (!block.alert) {
    log(`OK ${summarize(block)}`);
    return 0;
  }
  log(`ALERT ${summarize(block)}`);
  const delivered = deliveredToday(stateFile, day);
  {
    const text = alertPost(block, wake);
    const send = post ?? ((t) => execFileSync(sayCmd, ['--as', 'fp', t], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60_000 }));
    const paste = pane ?? ((t) => {
      execFileSync('tmux', ['load-buffer', '-b', 'fp-judge', '-'], { input: t, timeout: 10_000 });
      execFileSync('tmux', ['paste-buffer', '-b', 'fp-judge', '-d', '-t', paneTarget], { timeout: 10_000 });
      execFileSync('tmux', ['send-keys', '-t', paneTarget, 'Enter'], { timeout: 10_000 });
    });
    if (!delivered.posted && sayCmd !== '' && wake.length > 0) {
      try { send(text); delivered.posted = true; log(`posted, waking: ${wake.join(', ')}`); } catch (err) { log(`post failed: ${redact(err instanceof Error ? err.message : 'error', key).slice(0, 120)}`); }
    }
    if (!delivered.pasted && paneTarget !== '') {
      try { paste(`[judge-fallback-check] ${text}`); delivered.pasted = true; log(`pasted into ${paneTarget}`); } catch (err) { log(`pane paste failed: ${redact(err instanceof Error ? err.message : 'error', key).slice(0, 120)}`); }
    }
    markDelivered(stateFile, day, delivered);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
