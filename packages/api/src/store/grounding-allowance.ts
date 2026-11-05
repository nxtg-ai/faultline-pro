import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { subscribeUsage, type UsageLeg } from '@nxtg/faultline/lib/usage-sink.js';

/**
 * grounding-allowance.ts — daily count of Gemini GROUNDED prompts this server
 * actually sent, against Google's free daily grounding allowance (N-230).
 *
 * Asif ruling 2026-10-01 (wolf relay al:9331f52f622f3aea): alert when the
 * production grounded-prompt count passes 80% of the free daily allowance
 * (1,200 of 1,500). Past 1,500 every grounded prompt costs $0.035, so a
 * default-pipeline scan goes from about $0.01 to about $0.22. The alert is the
 * signal to reprice on real usage.
 *
 * WHAT COUNTS. One row per successful `generateContent` call that carried the
 * `googleSearch` tool on Gemini (`verifyClaim`, `retrieveSources` in the
 * engine's geminiService). Gemini 2.5 grounding is billed per PROMPT, not per
 * search query (https://ai.google.dev/gemini-api/docs/google-search), so a
 * tool-enabled prompt counts even when the model chose not to search: the count
 * is an upper bound on billed prompts, which is the safe direction for an alert.
 * Failed calls (429/5xx/network) return no response and are NOT counted; no
 * source says they count toward the allowance (docs/grounding-allowance-alert.md).
 * OpenAI web_search legs are also `isGrounding` but are a different provider and
 * a different bill, so they are excluded.
 *
 * WHERE IT COUNTS. A process-wide `subscribeUsage` observer on the engine's
 * usage sink, not the per-route capture scopes: /scan, /scan/stream and
 * /critique capture usage, but batch, bulk, deep, schedules and the scan queue
 * call the engine uncaptured, and those prompts draw on the same allowance.
 *
 * THE DAY. Google resets requests-per-day quotas at midnight Pacific time
 * (https://ai.google.dev/gemini-api/docs/rate-limits), and the pricing page
 * states the grounding allowance as "1,500 RPD". The allowance-day is therefore
 * the America/Los_Angeles calendar date, DST-aware via Intl, never a fixed offset.
 *
 * DURABILITY mirrors provider-spend.ts: an append-only JSONL ledger is the
 * authority and the in-process count is hydrated from it once per day per
 * process, so a process restart on the same machine does not reset the count.
 * The ledger lives on the Fly machine's filesystem, which is not a volume, so a
 * redeploy or machine replacement still starts a new file. `processStartedAt`
 * and `ledgerWriteFailures` on GET /usage make both conditions visible.
 */

/** Google's free daily grounded-prompt allowance on the paid tier (Gemini 2.5). */
export const FREE_DAILY_GROUNDED_PROMPTS = 1500;
/** Asif ruling 2026-10-01: alert at 80% of the free allowance. */
export const GROUNDING_ALERT_THRESHOLD = 1200;
/** Google's RPD reset clock. */
export const ALLOWANCE_TIME_ZONE = 'America/Los_Angeles';

const DEFAULT_LEDGER_PATH = '/var/log/faultline/grounding-prompts.jsonl';
const PROCESS_STARTED_AT = new Date().toISOString();

/** One grounded prompt sent to Gemini. Append-only; no PII (no key, no text). */
export interface GroundedPromptEvent {
  ts: string;        // ISO-8601
  day: string;       // YYYY-MM-DD in America/Los_Angeles
  provider: 'gemini';
  model?: string;
  callType?: string;
}

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ALLOWANCE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The allowance-day (Pacific calendar date, YYYY-MM-DD) a moment falls in. */
export function allowanceDay(now: Date = new Date()): string {
  return dayFormatter.format(now);
}

/** Minutes the Pacific zone is offset from UTC at `at` (e.g. -420 in PDT). */
function pacificOffsetMinutes(at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: ALLOWANCE_TIME_ZONE, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/** When the current allowance-day ends: the next 00:00 Pacific, as an ISO UTC instant. */
export function allowanceResetsAt(now: Date = new Date()): string {
  const [y, m, d] = allowanceDay(now).split('-').map(Number);
  const nextMidnightAsUtc = Date.UTC(y, m - 1, d + 1);
  // Probe the offset a few hours into the next UTC day: that is still before the
  // 02:00 local DST switch, so it is the offset in force at local midnight.
  const offset = pacificOffsetMinutes(new Date(nextMidnightAsUtc + 8 * 3_600_000));
  return new Date(nextMidnightAsUtc - offset * 60_000).toISOString();
}

/** Where the append-only ledger lives. `FAULTLINE_GROUNDING_LEDGER` overrides. */
export function groundingLedgerPath(): string {
  const raw = (process.env.FAULTLINE_GROUNDING_LEDGER ?? '').trim();
  return raw === '' ? DEFAULT_LEDGER_PATH : raw;
}

/** True only for a Gemini call that carried the googleSearch tool. */
export function isGroundedGeminiLeg(leg: UsageLeg): boolean {
  return leg.provider === 'gemini' && leg.isGrounding === true;
}

class GroundingAllowanceLedger {
  /** allowance-day → grounded prompts, hydrated from the ledger then kept live. */
  private counts = new Map<string, number>();
  private hydrated = new Set<string>();
  private writeFailures = 0;

  /**
   * Count the ledger rows for `day` once per process. Runs before the first
   * in-process increment for that day, so no row is ever counted twice.
   * Unparseable rows are skipped: a corrupt line must not zero the count.
   */
  private ensureHydrated(day: string): void {
    if (this.hydrated.has(day)) return;
    this.hydrated.add(day);
    let raw: string;
    try {
      const path = groundingLedgerPath();
      if (!existsSync(path)) return;
      raw = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    let rows = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        if ((JSON.parse(line) as Partial<GroundedPromptEvent>).day === day) rows += 1;
      } catch {
        continue;
      }
    }
    if (rows > 0) this.counts.set(day, (this.counts.get(day) ?? 0) + rows);
  }

  /** Ledger one grounded prompt and advance its day's count. */
  record(event: GroundedPromptEvent): void {
    this.ensureHydrated(event.day);
    this.counts.set(event.day, (this.counts.get(event.day) ?? 0) + 1);
    try {
      const path = groundingLedgerPath();
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(path, JSON.stringify(event) + '\n');
    } catch {
      // A failed write must never fail a scan; the count is surfaced on /usage.
      this.writeFailures += 1;
    }
  }

  /** Grounded prompts sent on `day`: ledger-hydrated, then live. */
  dayCount(day: string = allowanceDay()): number {
    this.ensureHydrated(day);
    return this.counts.get(day) ?? 0;
  }

  getWriteFailures(): number {
    return this.writeFailures;
  }

  /** Drop in-process state (tests / ledger-path changes). Does not touch the file. */
  reset(): void {
    this.counts.clear();
    this.hydrated.clear();
    this.writeFailures = 0;
  }
}

let ledger: GroundingAllowanceLedger | null = null;

export function getGroundingAllowanceLedger(): GroundingAllowanceLedger {
  if (!ledger) ledger = new GroundingAllowanceLedger();
  return ledger;
}

/** Reset the singleton — required after changing the ledger path in tests. */
export function resetGroundingAllowanceLedger(): void {
  ledger?.reset();
  ledger = null;
}

/** Count one usage leg if it is a grounded Gemini prompt. Returns whether it counted. */
export function recordGroundedLeg(leg: UsageLeg, now: Date = new Date()): boolean {
  if (!isGroundedGeminiLeg(leg)) return false;
  getGroundingAllowanceLedger().record({
    ts: now.toISOString(),
    day: allowanceDay(now),
    provider: 'gemini',
    model: leg.model,
    callType: leg.callType,
  });
  return true;
}

let unsubscribe: (() => void) | null = null;

/**
 * Attach the counter to the engine's usage sink. Idempotent: buildServer() runs
 * once per test file, and a second subscription would double-count every prompt.
 */
export function installGroundingCounter(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeUsage((leg) => {
    recordGroundedLeg(leg);
  });
}

/** Detach the counter (tests). */
export function uninstallGroundingCounter(): void {
  unsubscribe?.();
  unsubscribe = null;
}

/** The allowance position GET /usage reports to the admin key. */
export interface GroundingAllowanceStatus {
  day: string;
  clock: typeof ALLOWANCE_TIME_ZONE;
  resetsAt: string;
  groundedPrompts: number;
  freeDailyLimit: number;
  alertThreshold: number;
  overThreshold: boolean;
  overFreeLimit: boolean;
  processStartedAt: string;
  ledgerWriteFailures: number;
}

export function getGroundingAllowanceStatus(now: Date = new Date()): GroundingAllowanceStatus {
  const day = allowanceDay(now);
  const groundedPrompts = getGroundingAllowanceLedger().dayCount(day);
  return {
    day,
    clock: ALLOWANCE_TIME_ZONE,
    resetsAt: allowanceResetsAt(now),
    groundedPrompts,
    freeDailyLimit: FREE_DAILY_GROUNDED_PROMPTS,
    alertThreshold: GROUNDING_ALERT_THRESHOLD,
    overThreshold: groundedPrompts >= GROUNDING_ALERT_THRESHOLD,
    overFreeLimit: groundedPrompts >= FREE_DAILY_GROUNDED_PROMPTS,
    processStartedAt: PROCESS_STARTED_AT,
    ledgerWriteFailures: getGroundingAllowanceLedger().getWriteFailures(),
  };
}
