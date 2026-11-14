import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { subscribeUsage, type UsageLeg } from '@nxtg/faultline/lib/usage-sink.js';
import { GEMINI_MODEL } from '@nxtg/faultline/services/geminiService.js';

/**
 * Which Gemini model judged each claim, counted per UTC day (GoPMO 1.18.11.7.127, ruling
 * Dx3 abccffac item 4).
 *
 * The production judge is FAULTLINE_GEMINI_MODEL; when it answers with a rate limit, the claim
 * goes to a fallback judge. This counter tells how often that happens. If the fallback judged more
 * than 10% of claims over the last 7 days, that is the signal to price a higher Google tier.
 *
 * WHERE IT COUNTS. A process-wide `subscribeUsage` observer, as the grounding allowance counter
 * does. Every successful Gemini judge call emits one usage leg with callType
 * 'grounded-verify:gemini' and the model it ran on. A call that failed (a rate limit, say) emits
 * no leg, so a claim counts once, under the model that produced its verdict.
 *
 * The ledger is append-only, one row per judge call, ids and labels only. It lives on the ledger
 * volume beside the other ledgers, so a deploy keeps it. `FAULTLINE_JUDGE_MODEL_LEDGER` overrides
 * the path. A failed write never fails a scan; it is counted and shown on /usage.
 */

const DEFAULT_LEDGER_PATH = '/var/log/faultline/judge-models.jsonl';
export const JUDGE_WINDOW_DAYS = 7;
export const FALLBACK_ALERT_SHARE = 0.10;

export interface JudgeCallEvent {
  ts: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  model: string;
}

export function judgeLedgerPath(): string {
  const raw = (process.env.FAULTLINE_JUDGE_MODEL_LEDGER ?? '').trim();
  return raw === '' ? DEFAULT_LEDGER_PATH : raw;
}

/** True for a Gemini verdict-judge call (Google-grounded or the parallel judge). */
export function isGeminiJudgeLeg(leg: UsageLeg): boolean {
  return leg.provider === 'gemini' && leg.callType === 'grounded-verify:gemini';
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The UTC days in the window ending today, oldest first. */
export function windowDays(now: Date = new Date(), days: number = JUDGE_WINDOW_DAYS): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(utcDay(new Date(now.getTime() - i * 86_400_000)));
  return out;
}

class JudgeModelLedger {
  /** day → model → judge calls, hydrated from the file once, then kept live. */
  private counts = new Map<string, Map<string, number>>();
  private hydrated = false;
  private writeFailures = 0;

  private add(day: string, model: string): void {
    const byModel = this.counts.get(day) ?? new Map<string, number>();
    byModel.set(model, (byModel.get(model) ?? 0) + 1);
    this.counts.set(day, byModel);
  }

  /** Read the file once per process, before the first live count. Unreadable lines are skipped. */
  private ensureHydrated(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    let raw: string;
    try {
      const path = judgeLedgerPath();
      if (!existsSync(path)) return;
      raw = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as Partial<JudgeCallEvent>;
        if (typeof row.day === 'string' && typeof row.model === 'string' && row.model !== '') this.add(row.day, row.model);
      } catch {
        continue;
      }
    }
  }

  record(event: JudgeCallEvent): void {
    this.ensureHydrated();
    this.add(event.day, event.model);
    try {
      const path = judgeLedgerPath();
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(path, JSON.stringify(event) + '\n');
    } catch {
      this.writeFailures += 1;
    }
  }

  /** model → judge calls summed over `days`. */
  countsOver(days: string[]): Record<string, number> {
    this.ensureHydrated();
    const out: Record<string, number> = {};
    for (const day of days) {
      for (const [model, n] of this.counts.get(day) ?? []) out[model] = (out[model] ?? 0) + n;
    }
    return out;
  }

  getWriteFailures(): number {
    return this.writeFailures;
  }

  reset(): void {
    this.counts.clear();
    this.hydrated = false;
    this.writeFailures = 0;
  }
}

let ledger: JudgeModelLedger | null = null;

export function getJudgeModelLedger(): JudgeModelLedger {
  if (!ledger) ledger = new JudgeModelLedger();
  return ledger;
}

/** Reset the singleton (tests, or after changing the ledger path). */
export function resetJudgeModelLedger(): void {
  ledger?.reset();
  ledger = null;
}

/** Count one usage leg if it is a Gemini judge call with a known model. Returns whether it counted. */
export function recordJudgeLeg(leg: UsageLeg, now: Date = new Date()): boolean {
  if (!isGeminiJudgeLeg(leg) || typeof leg.model !== 'string' || leg.model === '' || leg.model === '?') return false;
  getJudgeModelLedger().record({ ts: now.toISOString(), day: utcDay(now), model: leg.model });
  return true;
}

let unsubscribe: (() => void) | null = null;

/** Attach the counter to the engine's usage sink. Idempotent, like the grounding counter. */
export function installJudgeModelCounter(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeUsage((leg) => {
    recordJudgeLeg(leg);
  });
}

export function uninstallJudgeModelCounter(): void {
  unsubscribe?.();
  unsubscribe = null;
}

export interface JudgeModelStatus {
  windowDays: number;
  from: string;
  to: string;
  /** The configured primary judge. Every other model in `byModel` judged as a fallback. */
  primary: string;
  byModel: Record<string, number>;
  total: number;
  /** Share of judge calls in the window made by any model other than the primary; null with no calls. */
  fallbackShare: number | null;
  alertShare: number;
  /** True when fallbackShare is above alertShare. */
  alert: boolean;
  ledgerWriteFailures: number;
}

export function getJudgeModelStatus(now: Date = new Date(), primary: string = GEMINI_MODEL): JudgeModelStatus {
  const days = windowDays(now);
  const byModel = getJudgeModelLedger().countsOver(days);
  const total = Object.values(byModel).reduce((s, n) => s + n, 0);
  const fallback = total - (byModel[primary] ?? 0);
  const fallbackShare = total === 0 ? null : fallback / total;
  return {
    windowDays: JUDGE_WINDOW_DAYS,
    from: days[0],
    to: days[days.length - 1],
    primary,
    byModel,
    total,
    fallbackShare,
    alertShare: FALLBACK_ALERT_SHARE,
    alert: fallbackShare !== null && fallbackShare > FALLBACK_ALERT_SHARE,
    ledgerWriteFailures: getJudgeModelLedger().getWriteFailures(),
  };
}
