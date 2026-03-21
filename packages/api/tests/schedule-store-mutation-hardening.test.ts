/**
 * N-129 — ScheduleStore + nextCronTime + parseCron second-pass hardening (SH1–SH15)
 *
 * Targets surviving mutants not killed by N-128 (SR1–SR16):
 *
 * parseCron (lines 93–95):
 *   - SH1: step=1 valid (kills `step <= 1` mutant at line 95)
 *   - SH2: step=0 invalid (kills `step < 0` mutant at line 95)
 *   - SH3: comma-separated values valid (covers line 101/106 regex paths)
 *   - SH4: comma-list with out-of-bounds value invalid (exercises single-value check)
 *
 * nextCronTime — range/value matching in matches() (lines 129, 134, 136, 138):
 *   - SH5: plain integer field — kills `if (true)` at line 134 (forces range block for integers)
 *   - SH6: range field from midpoint — kills `if (false)` at line 134 (skips range→parseInt)
 *   - SH7: range upper bound exactly — kills `value <= b` → `value < b` at line 136
 *   - SH8: comma list — covers line 138 `parseInt(part) === value` equality check
 *   - SH9: range lower bound exactly — kills `value >= a` → `value > a` at line 136
 *
 * ScheduleStore.create() (lines 175, 187):
 *   - SH10: MAX_SCHEDULES capacity guard (kills ConditionalExpression on line 175)
 *   - SH11: description default '' when omitted (kills line 187 `?? ''`)
 *
 * ScheduleStore.update() conditional patches (lines 220–226, 231):
 *   - SH12: update provider only — provider changes, status stays 'active'
 *   - SH13: update status only — status changes, provider stays unchanged
 *   - SH14: update cron — nextRunAt changes after cron patch
 *
 * ScheduleStore.recordRun() maxRuns completion (line 272):
 *   - SH15: maxRuns=1 → status='completed' after exactly 1 run (kills `>= maxRuns` → `> maxRuns`)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseCron,
  nextCronTime,
  getScheduleStore,
  resetScheduleStore,
} from '../src/store/schedules.js';

// ── parseCron: step boundaries (SH1–SH2) ─────────────────────────────────────

describe('parseCron — step boundary conditions', () => {
  // SH1: step=1 is the minimum valid step (kills `step <= 1` mutant at line 95)
  // With `step <= 1`: step=1 → 1<=1 → true → invalid — test asserts valid → kills mutant
  it('SH1: */1 (step=1) is valid — minimum allowed step', () => {
    expect(parseCron('*/1 * * * *').valid).toBe(true);
    expect(parseCron('0 */1 * * *').valid).toBe(true);
  });

  // SH2: step=0 is invalid (kills `step < 0` mutant at line 95)
  // With `step < 0`: step=0 → 0<0 → false → continue (accepted!) — test asserts invalid → kills mutant
  it('SH2: */0 (step=0) is invalid — step must be ≥ 1', () => {
    const r = parseCron('*/0 * * * *');
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/step must be/);
  });
});

// ── parseCron: comma-separated values (SH3–SH4) ──────────────────────────────

describe('parseCron — comma-separated value lists', () => {
  // SH3: valid comma list exercises the /^\d+$/ (line 106) branch for each part
  // Kills ConditionalExpression mutations on the digit-match regex test
  it('SH3: comma-separated values within range are valid', () => {
    expect(parseCron('0,15,30,45 * * * *').valid).toBe(true);
    expect(parseCron('0 0,6,12,18 * * *').valid).toBe(true);
    expect(parseCron('* * 1,15,28 * *').valid).toBe(true);
  });

  // SH4: comma list where one value is out of bounds → invalid
  // Kills mutations that remove the n > max / n < min check for plain values
  it('SH4: comma list with out-of-bounds value is invalid', () => {
    const r = parseCron('0,60 * * * *'); // 60 > max 59 for minutes
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/out of bounds/);
  });
});

// ── nextCronTime: range/value matching (SH5–SH9) ─────────────────────────────

describe('nextCronTime — precise value and range resolution', () => {
  // SH5: plain integer field — resolves to that exact minute
  // Kills `if (true)` mutant at line 134 in matches():
  //   With if(true), integer '15' enters range block: a=15, b=NaN → 15<=NaN is false
  //   → matches(15,'15') returns false → minute 15 never matches → test fails → kills mutant
  it('SH5: plain minute value "15" from :14 resolves to :15', () => {
    const base = new Date('2026-01-15T10:14:00Z');
    const next = nextCronTime('15 * * * *', base);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(15);
    expect(next!.getUTCHours()).toBe(10);
  });

  // SH6: range field from midpoint (not the lower bound)
  // Kills `if (false)` mutant at line 134 in matches():
  //   With if(false), part '10-20' skips range block → parseInt('10-20')=10 → only matches :10
  //   From :14, next would be :10 on the next hour, not :15 → test asserts :15 → kills mutant
  it('SH6: minute range "10-20" from :14 resolves to :15 (not :10)', () => {
    const base = new Date('2026-01-15T10:14:00Z');
    const next = nextCronTime('10-20 * * * *', base);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(15);
    expect(next!.getUTCHours()).toBe(10);
  });

  // SH7: range upper bound exactly (value === b)
  // Kills `value <= b` → `value < b` mutant at line 136:
  //   With value < b: 20 < 20 → false → :20 not matched → returns :10 next hour
  //   Test asserts :20 → kills mutant
  it('SH7: minute range "10-20" from :19 resolves to :20 (inclusive upper bound)', () => {
    const base = new Date('2026-01-15T10:19:00Z');
    const next = nextCronTime('10-20 * * * *', base);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(20);
    expect(next!.getUTCHours()).toBe(10);
  });

  // SH8: comma list — tests line 138 `parseInt(part, 10) === value` equality
  // Kills mutations that change === to !== or modify the parseInt
  it('SH8: comma minute list "0,15,30,45" from :44 resolves to :45', () => {
    const base = new Date('2026-01-15T10:44:00Z');
    const next = nextCronTime('0,15,30,45 * * * *', base);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(45);
    expect(next!.getUTCHours()).toBe(10);
  });

  // SH9: range lower bound exactly (value === a)
  // Kills `value >= a` → `value > a` mutant at line 136:
  //   With value > a: 10 > 10 → false → :10 not matched → returns :11
  //   Test asserts :10 → kills mutant
  // (Note: SR10 tests from :05→:10 but doesn't kill this — parseInt('10-20')===10 also returns :10)
  it('SH9: minute range "10-20" from :09 resolves to :10 (inclusive lower bound)', () => {
    const base = new Date('2026-01-15T10:09:00Z');
    const next = nextCronTime('10-20 * * * *', base);
    expect(next).not.toBeNull();
    expect(next!.getUTCMinutes()).toBe(10);
    expect(next!.getUTCHours()).toBe(10);
  });
});

// ── ScheduleStore.create(): capacity and defaults (SH10–SH11) ────────────────

describe('ScheduleStore.create() — capacity and field defaults', () => {
  beforeEach(() => resetScheduleStore());

  // SH10: MAX_SCHEDULES=500 capacity guard (kills ConditionalExpression on line 175)
  // With if(false): capacity never throws → assertion that 501st throws fails → kills mutant
  it('SH10: throws when schedule count reaches MAX_SCHEDULES (500)', () => {
    for (let i = 0; i < 500; i++) {
      getScheduleStore().create({ name: `S${i}`, cron: '0 9 * * *', text: 'x' }, 'k');
    }
    expect(() =>
      getScheduleStore().create({ name: 'overflow', cron: '0 9 * * *', text: 'x' }, 'k'),
    ).toThrow('Schedule limit reached');
  });

  // SH11: description defaults to '' when not provided (kills line 187 `?? ''` mutation)
  // With `?? undefined`: description would be undefined, not ''
  it('SH11: create without description defaults description to empty string', () => {
    const s = getScheduleStore().create({ name: 'S', cron: '0 9 * * *', text: 'x' }, 'k');
    expect(s.description).toBe('');
    expect(s.description).not.toBeUndefined();
  });
});

// ── ScheduleStore.update() conditional patches (SH12–SH14) ───────────────────

describe('ScheduleStore.update() — conditional field patching', () => {
  beforeEach(() => resetScheduleStore());

  // SH12: update provider only — status must stay 'active' (not undefined)
  // Kills `if (patch.status !== undefined)` → `if (true)` which would set status=undefined
  // Also kills `if (patch.provider !== undefined)` → `if (false)` which would skip provider update
  it('SH12: updating only provider leaves status unchanged at "active"', () => {
    const s = getScheduleStore().create(
      { name: 'P', cron: '0 9 * * *', text: 'x', provider: 'gemini' }, 'k');
    const updated = getScheduleStore().update(s.id, { provider: 'openai' });
    expect(updated).not.toBeNull();
    expect(updated!.provider).toBe('openai');
    expect(updated!.status).toBe('active'); // must NOT become undefined
  });

  // SH13: update status only — provider must stay 'gemini' (not undefined)
  // Kills `if (patch.provider !== undefined)` → `if (true)` which would set provider=undefined
  // Also kills `if (patch.status !== undefined)` → `if (false)` which would skip status update
  it('SH13: updating only status leaves provider unchanged', () => {
    const s = getScheduleStore().create(
      { name: 'Q', cron: '0 9 * * *', text: 'x', provider: 'gemini' }, 'k');
    const updated = getScheduleStore().update(s.id, { status: 'paused' });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('paused');
    expect(updated!.provider).toBe('gemini'); // must NOT become undefined
  });

  // SH14: updating cron changes nextRunAt (kills line 231 mutations)
  // With nextRunAt line removed/mutated: nextRunAt would be stale after cron change
  it('SH14: updating cron recalculates nextRunAt', () => {
    const s = getScheduleStore().create(
      { name: 'R', cron: '0 9 * * *', text: 'x' }, 'k');
    const originalNextRun = s.nextRunAt;
    // Change to a cron that fires at a very different time
    const updated = getScheduleStore().update(s.id, { cron: '30 23 * * *' });
    expect(updated).not.toBeNull();
    expect(updated!.cron).toBe('30 23 * * *');
    // nextRunAt must have changed since the schedule now fires at a different time
    expect(updated!.nextRunAt).not.toBeNull();
    expect(updated!.nextRunAt).not.toBe(originalNextRun);
  });
});

// ── ScheduleStore.recordRun(): maxRuns completion (SH15) ─────────────────────

describe('ScheduleStore.recordRun() — maxRuns completion gate', () => {
  beforeEach(() => resetScheduleStore());

  // SH15: maxRuns=1 — after exactly 1 run, status becomes 'completed'
  // Kills: `s.runCount >= s.maxRuns` → `s.runCount > s.maxRuns` at line 272
  //   With > mutant: 1 > 1 is false → status stays 'active' → assertion fails → kills mutant
  // Kills: BlockStatement removal of the completion block
  //   Without the block: status never changes → assertion fails → kills mutant
  it('SH15: maxRuns=1 — status becomes "completed" after exactly 1 recorded run', () => {
    const s = getScheduleStore().create(
      { name: 'MaxOne', cron: '0 9 * * *', text: 'x', maxRuns: 1 }, 'k');
    expect(s.status).toBe('active');

    getScheduleStore().recordRun(s.id, {
      ranAt: new Date().toISOString(),
      durationMs: 5,
      overallRisk: 'low',
      claimCount: 1,
      provider: 'gemini',
      inputSource: 'text',
      inputSize: 1,
    });

    const updated = getScheduleStore().get(s.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.status).toBe('completed'); // must be 'completed' after exactly maxRuns runs
  });
});
