/**
 * N-128 — ScheduleRunner + parseCron + nextCronTime mutation hardening (SR1–SR16)
 *
 * Targets surviving mutants in schedules.ts not killed by N-127 tests:
 *
 * parseCron (lines 78–116):
 *   - line 78:  `/\s+/` split regex → double-space input accepted
 *   - lines 85–88: range bounds array mutations (minute 0–59, hour 0–23, day 1–31, month 1–12)
 *   - line 95:  step `< 1` boundary
 *   - line 103: `a < min` in range check (day range starting at 0)
 *   - line 108: `n > max` in value check (weekday > 7)
 *
 * nextCronTime (lines 124–165):
 *   - line 129: `/^\*\/\d+$/` step regex
 *   - line 130: `value % step === 0` step-match arithmetic
 *   - lines 134–136: range match `value >= a && value <= b`
 *   - line 145: `t.setMinutes(t.getMinutes() + 1)` advance step
 *   - lines 149–153: UTC field extraction (getUTCMinutes, getUTCHours, etc.)
 *
 * ScheduleStore.create() (lines 175–231):
 *   - line 175: MAX_SCHEDULES capacity check
 *   - lines 191–194: default provider 'gemini', default maxRuns 0
 *
 * ScheduleRunner.runSchedule() (lines 315–365):
 *   - line 333: `inputSource = 'url'` assignment (BlockStatement)
 *   - line 335: `inputSource = 'text'` in else branch
 *   - lines 357–361: error catch block (BlockStatement, overallRisk 'unknown', errorMsg)
 *
 * Tests SR1–SR15.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseCron,
  nextCronTime,
  getScheduleStore,
  getScheduleRunner,
  resetScheduleStore,
  resetScheduleRunner,
} from '../src/store/schedules.js';

// ── Mock scan (used by ScheduleRunner.runSchedule) ────────────────────────────

const { mockScan } = vi.hoisted(() => ({ mockScan: vi.fn() }));

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: mockScan,
}));

// ── parseCron: regex split (SR1) ──────────────────────────────────────────────

describe('parseCron — whitespace regex', () => {
  // SR1: double-space between fields still parses as 5 fields (kills /\s+/ → /\s/ mutant)
  // With /\s/, "0  9 * * 1" splits into ["0", "", "9", "*", "*", "1"] → 6 fields → invalid
  // With /\s+/, splits into ["0", "9", "*", "*", "1"] → 5 fields → valid
  it('SR1: double-space-separated cron expression is valid (\\s+ not \\s)', () => {
    expect(parseCron('0  9 * * 1').valid).toBe(true);
    expect(parseCron('*/5  *  *  *  *').valid).toBe(true);
  });
});

// ── parseCron: range bounds (SR2–SR5) ─────────────────────────────────────────

describe('parseCron — range bounds', () => {
  // SR2: day-of-month minimum is 1 (not 0)
  // Kills: lower bound of day range mutated from [1,31] to [0,31]
  it('SR2: day=0 is invalid (min=1)', () => {
    const r = parseCron('* * 0 * *');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/out of bounds/);
  });

  // SR3: month minimum is 1 (not 0)
  // Kills: lower bound of month range mutated from [1,12] to [0,12]
  it('SR3: month=0 is invalid (min=1)', () => {
    const r = parseCron('* * * 0 *');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/out of bounds/);
  });

  // SR4: weekday maximum is 7 (0 and 7 both = Sunday)
  // Kills: upper bound mutated from [0,7] to [0,6]
  it('SR4: weekday=7 is valid (0 and 7 both mean Sunday)', () => {
    expect(parseCron('0 9 * * 7').valid).toBe(true);
  });

  // SR5: weekday=8 is invalid (> max=7)
  // Kills: `n > max` → `n >= max` which would reject 7
  it('SR5: weekday=8 is invalid (max=7)', () => {
    const r = parseCron('0 9 * * 8');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/out of bounds/);
  });
});

// ── parseCron: range part bounds (SR6–SR7) ────────────────────────────────────

describe('parseCron — range part boundary checks', () => {
  // SR6: day range starting at 0 is invalid (a < min=1 check)
  // Kills: `a < min` → `a > min` (would accept 0-5 as valid)
  it('SR6: day range 0-10 is invalid because 0 < minimum (1)', () => {
    const r = parseCron('* * 0-10 * *');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/out of bounds/);
  });

  // SR7: minute range ending at 65 is invalid (b > max=59 check)
  // Kills: `b > max` → `b >= max` (would reject valid range ending exactly at max)
  it('SR7: minute range 50-65 is invalid because 65 > maximum (59)', () => {
    const r = parseCron('50-65 * * * *');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/out of bounds/);
  });
});

// ── nextCronTime: step matching (SR8) ─────────────────────────────────────────

describe('nextCronTime — step matching', () => {
  // SR8: */5 step field: next run from xx:03 is xx:05 (not xx:03+1=xx:04)
  // Kills: `value % step === 0` → `value % step !== 0` or `value + step`
  it('SR8: */5 in minute field matches 0, 5, 10 … not arbitrary values', () => {
    // Start at 2026-01-01 00:03 UTC — next match is 00:05
    const base = new Date('2026-01-01T00:03:00Z');
    const next = nextCronTime('*/5 * * * *', base);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(5);
    expect(next!.getUTCHours()).toBe(0);
  });
});

// ── nextCronTime: specific time resolution (SR9–SR10) ─────────────────────────

describe('nextCronTime — specific time resolution', () => {
  // SR9: wildcard * matches any minute — next run is exactly 1 minute ahead
  // Kills: mutations on UTC field extractors (getUTCMinutes, getUTCHours, etc.)
  it('SR9: "* * * * *" returns a date exactly 1 minute after base', () => {
    const base = new Date('2026-01-15T10:30:00Z');
    const next = nextCronTime('* * * * *', base);
    expect(next).not.toBeNull();
    expect(next!.getTime() - base.getTime()).toBe(60_000);
  });

  // SR10: range match — "10-20" in minute field from base at :05 matches :10
  // Kills: `value >= a && value <= b` → `value > a` or `value <= a`
  it('SR10: minute range 10-20 from base at :05 resolves to :10', () => {
    const base = new Date('2026-01-15T10:05:00Z');
    const next = nextCronTime('10-20 * * * *', base);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(10);
  });
});

// ── ScheduleStore.create() defaults (SR11–SR12) ───────────────────────────────

describe('ScheduleStore.create() — defaults', () => {
  beforeEach(() => resetScheduleStore());

  // SR11: default provider is 'gemini' when not specified
  // Kills: StringLiteral `'gemini'` → `''` mutation on line 191
  it('SR11: create without provider defaults to "gemini"', () => {
    const s = getScheduleStore().create({ name: 'S', cron: '0 9 * * *', text: 'test' }, 'k1');
    expect(s.provider).toBe('gemini');
  });

  // SR12: default maxRuns is 0 (unlimited) when not specified
  // Kills: numeric literal `0` → `1` or `-1` mutation on line 194
  it('SR12: create without maxRuns defaults to 0 (unlimited)', () => {
    const s = getScheduleStore().create({ name: 'S', cron: '0 9 * * *', text: 'test' }, 'k1');
    expect(s.maxRuns).toBe(0);
  });
});

// ── ScheduleRunner.runSchedule() — text path (SR13) ──────────────────────────

describe('ScheduleRunner.runSchedule() — text-based schedule', () => {
  beforeEach(() => {
    resetScheduleStore();
    resetScheduleRunner();
    vi.clearAllMocks();
    mockScan.mockResolvedValue({
      overallRisk: 'low',
      claims: [{ id: 'c1', text: 'claim', type: 'fact', importance: 3 }],
    });
  });

  afterEach(() => {
    resetScheduleRunner();
  });

  // SR13: text schedule → inputSource = 'text' recorded in run history
  // Kills: `inputSource = 'text'` assignment mutation (line 335)
  // Also kills: BlockStatement removal of the else branch
  it('SR13: text-based schedule records inputSource "text" after runSchedule', async () => {
    const sched = getScheduleStore().create(
      { name: 'Text Sched', cron: '0 9 * * *', text: 'AI claims to cure cancer.' },
      'key-text',
    );

    await getScheduleRunner().runSchedule(sched);

    const updated = getScheduleStore().get(sched.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastResult).toBeDefined();
    expect(updated.lastResult!.inputSource).toBe('text');
    expect(updated.lastResult!.inputSize).toBe(sched.text!.length);
    expect(updated.lastResult!.error).toBeUndefined();
  });
});

// ── ScheduleRunner.runSchedule() — URL path (SR14) ───────────────────────────

describe('ScheduleRunner.runSchedule() — URL-based schedule', () => {
  beforeEach(() => {
    resetScheduleStore();
    resetScheduleRunner();
    vi.clearAllMocks();
    mockScan.mockResolvedValue({ overallRisk: 'medium', claims: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('Content from the fetched URL.'),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetScheduleRunner();
  });

  // SR14: URL schedule → fetch is called, inputSource = 'url' recorded
  // Kills: `inputSource = 'url'` assignment mutation (line 333)
  // Also kills: BlockStatement removal of the URL fetch branch
  it('SR14: URL-based schedule records inputSource "url" after runSchedule', async () => {
    const sched = getScheduleStore().create(
      { name: 'URL Sched', cron: '0 9 * * *', url: 'https://example.com/content' },
      'key-url',
    );

    await getScheduleRunner().runSchedule(sched);

    const updated = getScheduleStore().get(sched.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastResult!.inputSource).toBe('url');
    expect(updated.lastResult!.error).toBeUndefined();
    // fetch was called with the schedule URL
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'https://example.com/content',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });
});

// ── ScheduleRunner.runSchedule() — error path (SR15) ─────────────────────────

describe('ScheduleRunner.runSchedule() — error path', () => {
  beforeEach(() => {
    resetScheduleStore();
    resetScheduleRunner();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetScheduleRunner();
  });

  // SR15: scan() throws → error is recorded with overallRisk = 'unknown'
  // Kills: BlockStatement removal of catch block (line 357)
  // Kills: StringLiteral `'unknown'` → `''` mutation (line 361)
  // Kills: `err instanceof Error ? err.message : String(err)` (line 359)
  it('SR15: scan failure is recorded as error run with overallRisk "unknown"', async () => {
    mockScan.mockRejectedValue(new Error('provider timeout'));

    const sched = getScheduleStore().create(
      { name: 'Err Sched', cron: '0 9 * * *', text: 'Some text to scan.' },
      'key-err',
    );

    await getScheduleRunner().runSchedule(sched);

    const updated = getScheduleStore().get(sched.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastResult!.overallRisk).toBe('unknown');
    expect(updated.lastResult!.error).toBe('provider timeout');
    // With catch BlockStatement removed: runCount stays 0 and no error is stored
    expect(updated.lastResult!.claimCount).toBe(0);
  });

  // SR16: durationMs in error path is calculated as Date.now() - start (not +)
  // Kills: ArithmeticOperator `Date.now() - start` → `Date.now() + start` (line 358)
  // If mutated to +, durationMs would be ~2× the unix timestamp (≈3.5 trillion), not < 1000.
  it('SR16: durationMs in error catch path is a small non-negative number', async () => {
    mockScan.mockRejectedValue(new Error('timing mutant check'));

    const sched = getScheduleStore().create(
      { name: 'Duration Sched', cron: '0 9 * * *', text: 'Check duration.' },
      'key-dur',
    );

    await getScheduleRunner().runSchedule(sched);

    const updated = getScheduleStore().get(sched.id)!;
    expect(updated.lastResult!.durationMs).toBeGreaterThanOrEqual(0);
    expect(updated.lastResult!.durationMs).toBeLessThan(5_000); // must be < 5s, not ~3.5 trillion
  });
});
