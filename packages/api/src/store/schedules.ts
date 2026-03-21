/**
 * Schedule Store — recurring scan schedules for monitoring AI-generated content.
 *
 * Differences from the existing Job store:
 *   - Supports `url` input (fetches content, then scans) in addition to `text`
 *   - Full 5-field cron expression parsing (minute/hour/day/month/weekday)
 *   - Per-schedule run history (last 20 results)
 *   - Email notification dispatch via the notification store on completion
 *   - `name` and `description` metadata for monitoring dashboards
 *   - `maxRuns` ceiling (0 = unlimited)
 *   - `lastResult` snapshot attached to the schedule for quick dashboard view
 */

import { randomUUID } from 'node:crypto';
import { scan } from '@nxtg/faultline/cli/scan.js';
import { getNotificationStore, type NotificationEventType } from './notifications.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'error';
export type ScheduleProvider = 'gemini' | 'openai' | 'claude' | 'perplexity' | 'mock';

export interface ScheduleRunResult {
  runId:       string;
  ranAt:       string;
  durationMs:  number;
  overallRisk: string;
  claimCount:  number;
  provider:    string;
  error?:      string;
  inputSource: 'text' | 'url';
  inputSize:   number;
}

export interface Schedule {
  id:           string;
  name:         string;
  description:  string;
  cron:         string;           // e.g. "0 9 * * 1" = Monday 09:00
  text?:        string;           // direct text input
  url?:         string;           // URL to fetch + scan
  provider:     ScheduleProvider;
  notifyEmail?: string;           // email to notify on completion
  webhookUrl?:  string;
  maxRuns:      number;           // 0 = unlimited
  keyId:        string;
  status:       ScheduleStatus;
  createdAt:    string;
  updatedAt:    string;
  lastRunAt:    string | null;
  nextRunAt:    string | null;
  runCount:     number;
  history:      ScheduleRunResult[];  // last 20 runs
  lastResult?:  ScheduleRunResult;
}

export interface CreateScheduleInput {
  name:         string;
  description?: string;
  cron:         string;
  text?:        string;
  url?:         string;
  provider?:    ScheduleProvider;
  notifyEmail?: string;
  webhookUrl?:  string;
  maxRuns?:     number;
}

const MAX_SCHEDULES  = 500;
const MAX_HISTORY    = 20;

// ── Cron parser ───────────────────────────────────────────────────────────────

// Minimal 5-field cron parser.
// Supports: *, N, step (*/N), comma (N,M), range (N-M) per field.
// Fields: minute hour day-of-month month day-of-week
export function parseCron(expr: string): { valid: boolean; error?: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { valid: false, error: 'Cron expression must have exactly 5 fields (minute hour day month weekday).' };
  }
  const ranges = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day
    [1, 12],  // month
    [0, 7],   // weekday (0 and 7 = Sunday)
  ];
  for (let i = 0; i < 5; i++) {
    const f = fields[i];
    const [min, max] = ranges[i];
    if (f === '*') continue;
    if (/^\*\/\d+$/.test(f)) {
      const step = parseInt(f.slice(2), 10);
      if (step < 1) return { valid: false, error: `Field ${i + 1}: step must be ≥ 1.` };
      continue;
    }
    // comma-separated or single value or range
    const parts = f.split(',');
    for (const part of parts) {
      if (/^\d+-\d+$/.test(part)) {
        const [a, b] = part.split('-').map(Number);
        if (a < min || b > max || a > b) {
          return { valid: false, error: `Field ${i + 1}: range ${part} out of bounds [${min}-${max}].` };
        }
      } else if (/^\d+$/.test(part)) {
        const n = parseInt(part, 10);
        if (n < min || n > max) {
          return { valid: false, error: `Field ${i + 1}: value ${n} out of bounds [${min}-${max}].` };
        }
      } else {
        return { valid: false, error: `Field ${i + 1}: unrecognised value "${part}".` };
      }
    }
  }
  return { valid: true };
}

/**
 * Compute next run time after `after` for a given cron expression.
 * Advances minute-by-minute up to 366 days. Returns null if no match found.
 */
export function nextCronTime(cron: string, after: Date = new Date()): Date | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  function matches(value: number, field: string): boolean {
    if (field === '*') return true;
    if (/^\*\/\d+$/.test(field)) {
      const step = parseInt(field.slice(2), 10);
      return value % step === 0;
    }
    return field.split(',').some(part => {
      if (/^\d+-\d+$/.test(part)) {
        const [a, b] = part.split('-').map(Number);
        return value >= a && value <= b;
      }
      return parseInt(part, 10) === value;
    });
  }

  // Start 1 minute after `after`
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);

  const limit = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (t < limit) {
    const min  = t.getUTCMinutes();
    const hr   = t.getUTCHours();
    const dom  = t.getUTCDate();
    const mon  = t.getUTCMonth() + 1;
    const dow  = t.getUTCDay(); // 0=Sun

    if (
      matches(min, fields[0]) &&
      matches(hr,  fields[1]) &&
      matches(dom, fields[2]) &&
      matches(mon, fields[3]) &&
      (matches(dow, fields[4]) || (fields[4] === '7' && dow === 0))
    ) {
      return new Date(t);
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

// ── Store ─────────────────────────────────────────────────────────────────────

class ScheduleStore {
  private schedules: Map<string, Schedule> = new Map();

  create(input: CreateScheduleInput, keyId: string): Schedule {
    if (this.schedules.size >= MAX_SCHEDULES) {
      throw new Error(`Schedule limit reached (max ${MAX_SCHEDULES}).`);
    }
    const validation = parseCron(input.cron);
    if (!validation.valid) throw new Error(validation.error);
    if (!input.text && !input.url) throw new Error('Either text or url is required.');

    const now = new Date();
    const nextRun = nextCronTime(input.cron, now);
    const schedule: Schedule = {
      id:           randomUUID(),
      name:         input.name.trim(),
      description:  input.description?.trim() ?? '',
      cron:         input.cron.trim(),
      text:         input.text,
      url:          input.url,
      provider:     input.provider ?? 'gemini',
      notifyEmail:  input.notifyEmail,
      webhookUrl:   input.webhookUrl,
      maxRuns:      input.maxRuns ?? 0,
      keyId,
      status:       'active',
      createdAt:    now.toISOString(),
      updatedAt:    now.toISOString(),
      lastRunAt:    null,
      nextRunAt:    nextRun?.toISOString() ?? null,
      runCount:     0,
      history:      [],
    };
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  get(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  list(keyId?: string): Schedule[] {
    const all = Array.from(this.schedules.values());
    return keyId ? all.filter(s => s.keyId === keyId) : all;
  }

  update(id: string, patch: Partial<Pick<Schedule, 'name' | 'description' | 'cron' | 'notifyEmail' | 'webhookUrl' | 'status' | 'provider' | 'maxRuns'>>): Schedule | null {
    const s = this.schedules.get(id);
    if (!s) return null;
    if (patch.name        !== undefined) s.name        = patch.name;
    if (patch.description !== undefined) s.description = patch.description;
    if (patch.notifyEmail !== undefined) s.notifyEmail = patch.notifyEmail;
    if (patch.webhookUrl  !== undefined) s.webhookUrl  = patch.webhookUrl;
    if (patch.status      !== undefined) s.status      = patch.status;
    if (patch.provider    !== undefined) s.provider    = patch.provider;
    if (patch.maxRuns     !== undefined) s.maxRuns     = patch.maxRuns;
    if (patch.cron !== undefined) {
      const v = parseCron(patch.cron);
      if (!v.valid) throw new Error(v.error);
      s.cron = patch.cron;
      s.nextRunAt = nextCronTime(patch.cron)?.toISOString() ?? null;
    }
    s.updatedAt = new Date().toISOString();
    return s;
  }

  delete(id: string): boolean {
    return this.schedules.delete(id);
  }

  /** Delete all schedules associated with any of the given keyIds. Returns deleted count. */
  deleteForKeys(keyIds: string[]): number {
    const keySet = new Set(keyIds);
    let count = 0;
    for (const [id, s] of this.schedules) {
      if (keySet.has(s.keyId)) {
        this.schedules.delete(id);
        count++;
      }
    }
    return count;
  }

  /** Return all schedules for a set of keyIds. */
  listForKeys(keyIds: string[]): Schedule[] {
    const keySet = new Set(keyIds);
    return Array.from(this.schedules.values()).filter(s => keySet.has(s.keyId));
  }

  /** Record a completed run, update nextRunAt, and check maxRuns. */
  recordRun(id: string, result: Omit<ScheduleRunResult, 'runId'>): void {
    const s = this.schedules.get(id);
    if (!s) return;
    const run: ScheduleRunResult = { runId: randomUUID(), ...result };
    s.history.unshift(run);
    if (s.history.length > MAX_HISTORY) s.history.length = MAX_HISTORY;
    s.lastResult  = run;
    s.lastRunAt   = run.ranAt;
    s.runCount++;
    s.nextRunAt   = nextCronTime(s.cron)?.toISOString() ?? null;
    s.updatedAt   = new Date().toISOString();
    if (s.maxRuns > 0 && s.runCount >= s.maxRuns) {
      s.status = 'completed';
    }
  }

  reset(): void {
    this.schedules = new Map();
  }
}

let instance: ScheduleStore | null = null;
export function getScheduleStore(): ScheduleStore {
  if (!instance) instance = new ScheduleStore();
  return instance;
}
export function resetScheduleStore(): void {
  instance = new ScheduleStore();
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

class ScheduleRunner {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(tickMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, tickMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<void> {
    const now = Date.now();
    for (const schedule of getScheduleStore().list()) {
      if (schedule.status !== 'active') continue;
      if (!schedule.nextRunAt) continue;
      if (new Date(schedule.nextRunAt).getTime() > now) continue;
      void this.runSchedule(schedule).catch(() => undefined);
    }
  }

  async runSchedule(schedule: Schedule): Promise<void> {
    const start = Date.now();
    const ranAt = new Date().toISOString();
    let inputText: string;
    let inputSource: 'text' | 'url' = 'text';
    let inputSize = 0;

    try {
      // Fetch URL content if url-based schedule
      if (schedule.url) {
        const res = await fetch(schedule.url, {
          signal: AbortSignal.timeout(30_000),
          headers: { 'User-Agent': 'Faultline-Pro/2.0 scan-scheduler' },
        });
        if (!res.ok) throw new Error(`URL fetch failed: ${res.status} ${res.statusText}`);
        inputText = await res.text();
        inputText = inputText.slice(0, 50_000); // cap at 50K chars
        inputSource = 'url';
      } else {
        inputText = schedule.text ?? '';
        inputSource = 'text';
      }
      inputSize = inputText.length;

      const result = await scan(inputText, schedule.provider);
      const durationMs = Date.now() - start;
      const runResult: Omit<ScheduleRunResult, 'runId'> = {
        ranAt,
        durationMs,
        overallRisk: (result as { overallRisk?: string }).overallRisk ?? 'unknown',
        claimCount:  Array.isArray((result as { claims?: unknown[] }).claims)
                     ? (result as { claims: unknown[] }).claims.length
                     : 0,
        provider:    schedule.provider,
        inputSource,
        inputSize,
      };
      getScheduleStore().recordRun(schedule.id, runResult);

      // Dispatch notification
      await dispatchScheduleNotification(schedule, runResult, result);

    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const runResult: Omit<ScheduleRunResult, 'runId'> = {
        ranAt, durationMs, overallRisk: 'unknown', claimCount: 0,
        provider: schedule.provider, error: errorMsg, inputSource, inputSize,
      };
      getScheduleStore().recordRun(schedule.id, runResult);
      await dispatchScheduleNotification(schedule, runResult, null);
    }
  }
}

async function dispatchScheduleNotification(
  schedule: Schedule,
  runResult: Omit<ScheduleRunResult, 'runId'>,
  _scanResult: unknown,
): Promise<void> {
  try {
    const eventType: NotificationEventType = runResult.error ? 'scan.failed' : 'scan.completed';
    const payload: Record<string, unknown> = {
      scheduleId:   schedule.id,
      scheduleName: schedule.name,
      ranAt:        runResult.ranAt,
      durationMs:   runResult.durationMs,
      overallRisk:  runResult.overallRisk,
      claimCount:   runResult.claimCount,
      provider:     runResult.provider,
      source:       schedule.url ?? 'direct text',
      runCount:     (getScheduleStore().get(schedule.id)?.runCount ?? 0),
      notifyEmail:  schedule.notifyEmail,
    };
    if (runResult.error) payload['error'] = runResult.error;
    await getNotificationStore().dispatch(eventType, payload, schedule.keyId);
  } catch { /* non-fatal */ }
}

let runnerInstance: ScheduleRunner | null = null;
export function getScheduleRunner(): ScheduleRunner {
  if (!runnerInstance) runnerInstance = new ScheduleRunner();
  return runnerInstance;
}
export function resetScheduleRunner(): void {
  if (runnerInstance) runnerInstance.stop();
  runnerInstance = new ScheduleRunner();
}
