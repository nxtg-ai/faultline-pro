#!/usr/bin/env node
// Validates: N-230 (grounding allowance alert, Asif ruling 2026-10-01)
/**
 * Hourly check of production's daily Gemini grounded-prompt count against
 * Google's free allowance (1,500 a day, alert at 1,200). See
 * docs/grounding-allowance-alert.md.
 *
 * Reads GET <api>/usage with the server key (FAULTLINE_API_KEY from env, else
 * /home/axw/projects/faultline-web/.env.local; never printed) and:
 *   - appends one JSON row per run to the spend-monitor ledger,
 *   - sends one Telegram alert per allowance-day per level (threshold, free limit),
 *   - alerts on probe failure (first failure, then at most once a day).
 *
 * The server count lives on the Fly machine, so a redeploy restarts it at 0.
 * When the server's processStartedAt changes mid-day and its count drops, the
 * last count seen before the restart is carried forward. That undercounts only
 * the prompts sent between the last check and the restart.
 *
 * Exit: 0 OK, 1 ALERT (over threshold), 2 probe failure.
 * An alert also reaches fp (GoPMO 1.18.11.1.18): a typed Dx3 handoff and a paste into the fp
 * tmux pane, because Telegram reaches the founder's phone, not the lane that acts.
 *
 * Env: FAULTLINE_API_URL, FAULTLINE_API_KEY, GROUNDING_ALERT_THRESHOLD (client-side
 * override, used for the scheduler drill), GROUNDING_STATE_DIR, GROUNDING_MONITOR_LOG,
 * GROUNDING_NOTIFY, GROUNDING_WAKE_FP ('0' turns the fp handoff and pane wake off),
 * FP_TMUX_SESSION (default faultline-pro), DX3_API_URL.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = homedir();
const API_URL = (process.env.FAULTLINE_API_URL ?? 'https://faultline-api.fly.dev').replace(/\/+$/, '');
const ENV_FILE = '/home/axw/projects/faultline-web/.env.local';
const STATE_DIR = process.env.GROUNDING_STATE_DIR ?? join(HOME, '.cache', 'faultline-pro');
const STATE_FILE = join(STATE_DIR, 'grounding-alert-state.json');
const MONITOR_LOG = process.env.GROUNDING_MONITOR_LOG
  ?? join(HOME, 'ASIF', 'governance', 'spend-monitor', 'faultline-pro-grounding.jsonl');
const NOTIFY = process.env.GROUNDING_NOTIFY ?? join(HOME, 'ASIF', 'scripts', 'notify-telegram.sh');
const PROBE_FAIL_RENOTIFY_MS = 24 * 3_600_000;
const WAKE_FP = (process.env.GROUNDING_WAKE_FP ?? '1') !== '0';
const FP_SESSION = process.env.FP_TMUX_SESSION ?? 'faultline-pro';
const DX3 = (process.env.DX3_API_URL ?? 'http://100.123.83.34:8004').replace(/\/+$/, '');

/** The server key, from env or faultline-web's .env.local. Never logged. */
function readApiKey() {
  const fromEnv = (process.env.FAULTLINE_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(ENV_FILE)) return '';
  const line = readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith('FAULTLINE_API_KEY='));
  return line ? line.slice('FAULTLINE_API_KEY='.length).trim().replace(/^["']|["']$/g, '') : '';
}

/** Client-side threshold override, or null to use the server's. */
function thresholdOverride() {
  const raw = (process.env.GROUNDING_ALERT_THRESHOLD ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { alerted: [], days: {}, lastProbeFailureNotifiedAt: null };
  }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  state.alerted = state.alerted.slice(-60);
  const keepDays = Object.keys(state.days).sort().slice(-7);
  state.days = Object.fromEntries(keepDays.map((d) => [d, state.days[d]]));
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function appendMonitorRow(row) {
  mkdirSync(dirname(MONITOR_LOG), { recursive: true });
  appendFileSync(MONITOR_LOG, JSON.stringify(row) + '\n');
}

/** Send one Telegram line. execFile, not a shell: `$` and backticks stay literal. */
function notify(message) {
  try {
    execFileSync(NOTIFY, [message], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return true;
  } catch (error) {
    console.error(`notify failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Paste the alert into the fp pane and press Enter. True when the keys were sent (a nudge, not proof it was read). */
function wakeFp(message) {
  if (!WAKE_FP) return false;
  try {
    const panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}'],
      { encoding: 'utf8', timeout: 10_000 }).split('\n');
    const target = panes.find((pane) => pane.split(':')[0] === FP_SESSION);
    if (!target) return false;
    execFileSync('tmux', ['load-buffer', '-b', 'fp-grounding', '-'], { input: message, timeout: 10_000 });
    execFileSync('tmux', ['paste-buffer', '-b', 'fp-grounding', '-d', '-t', target], { timeout: 10_000 });
    execFileSync('sleep', ['0.3']);
    execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: 10_000 });
    return true;
  } catch (error) {
    console.error(`fp pane wake failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** A typed Dx3 handoff, so the alert survives an idle pane. Same id per day and level: a re-run updates it. */
async function mintHandoff(handoffId, content, priority) {
  if (!WAKE_FP) return null;
  try {
    const res = await fetch(`${DX3}/api/cognitive/upsert_handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handoff_id: handoffId, content, handoff_status: 'OPEN', from_machine: 'NXTG-AI', to_machine: 'NXTG-AI',
        subject: `[fp] GROUNDING ALLOWANCE ${handoffId}`, priority, project_ids: ['P-08'], source_ref: MONITOR_LOG,
        reason: 'grounding-allowance-check: grounded prompts at or past the alert threshold',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok ? ((await res.json()).record_id ?? null) : null;
  } catch (error) {
    console.error(`handoff mint failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function probe(apiKey) {
  const res = await fetch(`${API_URL}/usage`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200) throw new Error(`GET /usage returned HTTP ${res.status}`);
  const body = await res.json();
  const g = body?.groundingAllowance;
  if (!g || typeof g.groundedPrompts !== 'number' || typeof g.day !== 'string') {
    throw new Error('GET /usage has no groundingAllowance (old deploy, or not the admin key)');
  }
  return g;
}

/** Carry the pre-restart count forward when the server restarted mid-day. */
function effectiveCount(state, g) {
  const prev = state.days[g.day] ?? { processStartedAt: g.processStartedAt, lastServerCount: 0, carried: 0 };
  let carried = prev.carried ?? 0;
  const restarted = prev.processStartedAt !== g.processStartedAt && g.groundedPrompts < prev.lastServerCount;
  if (restarted) carried += prev.lastServerCount;
  state.days[g.day] = { processStartedAt: g.processStartedAt, lastServerCount: g.groundedPrompts, carried };
  return { count: g.groundedPrompts + carried, carried, restarted };
}

function handleProbeFailure(state, error) {
  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  const last = state.lastProbeFailureNotifiedAt ? Date.parse(state.lastProbeFailureNotifiedAt) : 0;
  const shouldNotify = now - last >= PROBE_FAIL_RENOTIFY_MS;
  const notified = shouldNotify
    ? notify(`Faultline grounding check FAILED: ${message}. The free-allowance alert is blind until this is fixed.`)
    : false;
  if (notified) state.lastProbeFailureNotifiedAt = new Date(now).toISOString();
  appendMonitorRow({ ts: new Date(now).toISOString(), verdict: 'PROBE_FAIL', error: message, notified });
  saveState(state);
  console.log(`${new Date(now).toISOString()} PROBE_FAIL ${message} notified=${notified}`);
  return 2;
}

async function main() {
  const state = loadState();
  const apiKey = readApiKey();
  if (!apiKey) return handleProbeFailure(state, new Error('FAULTLINE_API_KEY not found in env or faultline-web .env.local'));

  let g;
  try {
    g = await probe(apiKey);
  } catch (error) {
    return handleProbeFailure(state, error);
  }
  state.lastProbeFailureNotifiedAt = null;

  const override = thresholdOverride();
  const threshold = override ?? g.alertThreshold;
  const { count, carried, restarted } = effectiveCount(state, g);
  const overThreshold = count >= threshold;
  const overFreeLimit = count >= g.freeDailyLimit;

  let notified = false;
  let paneWoken = false;
  let handoffRecord = null;
  const level = overFreeLimit ? 'free-limit' : overThreshold ? 'threshold' : null;
  const dedupeKey = level ? `${g.day}:${level}:${threshold}` : null;
  if (dedupeKey && !state.alerted.includes(dedupeKey)) {
    const what = overFreeLimit
      ? `past the free ${g.freeDailyLimit}; each grounded prompt now costs $0.035`
      : `passed the alert threshold ${threshold} of ${g.freeDailyLimit} free`;
    const extras = [
      carried > 0 ? `includes ${carried} carried over a mid-day restart` : '',
      g.ledgerWriteFailures > 0 ? `server ledger write failures ${g.ledgerWriteFailures}` : '',
      override !== null ? `client threshold override ${override}` : '',
    ].filter(Boolean).join('; ');
    const message = `Faultline Gemini grounding: ${count} grounded prompts on ${g.day} (Pacific day), ${what}. `
      + `Resets ${g.resetsAt}. Time to reprice on real usage.${extras ? ` (${extras})` : ''}`;
    notified = notify(message);
    const handoffId = `hf-fp-grounding-${g.day}-${level}-${threshold}`;
    handoffRecord = await mintHandoff(handoffId, `From fp grounding-allowance-check: ${message} GoPMO 1.18.11.1.18. `
      + 'fp reads GET /usage, decides whether to slow or reprice, posts what it did, then acks this handoff.',
    overFreeLimit ? 'P0' : 'P1');
    paneWoken = wakeFp(`[grounding-allowance-check] ${message} Dx3 handoff ${handoffId}. GoPMO 1.18.11.1.18.`);
    if (notified || paneWoken) state.alerted.push(dedupeKey);
  }

  const verdict = overThreshold ? 'ALERT' : 'OK';
  appendMonitorRow({
    ts: new Date().toISOString(),
    verdict,
    day: g.day,
    groundedPrompts: count,
    serverGroundedPrompts: g.groundedPrompts,
    carried,
    restartedMidDay: restarted,
    alertThreshold: threshold,
    thresholdOverride: override,
    freeDailyLimit: g.freeDailyLimit,
    overThreshold,
    overFreeLimit,
    resetsAt: g.resetsAt,
    processStartedAt: g.processStartedAt,
    ledgerWriteFailures: g.ledgerWriteFailures,
    notified,
    paneWoken,
    handoffRecord,
  });
  saveState(state);
  console.log(
    `${new Date().toISOString()} ${verdict} day=${g.day} grounded=${count} threshold=${threshold} `
    + `free=${g.freeDailyLimit} carried=${carried} notified=${notified} paneWoken=${paneWoken}`,
  );
  return overThreshold ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`grounding-allowance-check crashed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(2);
  },
);
