/**
 * N-133 — ScheduleStore.update() + recordRun() mutation hardening (SH16–SH30)
 *
 * Targets 15+ surviving mutants in schedules.ts not killed by N-129 (SH1–SH15):
 *
 * update() conditional guards (lines 220–226):
 *   SH16: update with notifyEmail set → field updated           kills if(false) + !==→=== at line 222
 *   SH17: update with no notifyEmail  → field unchanged         kills if(true)  + !==→=== at line 222
 *   SH18: update with webhookUrl set  → field updated           kills if(false) + !==→=== at line 223
 *   SH19: update with no webhookUrl   → field unchanged         kills if(true)  + !==→=== at line 223
 *   SH20: update with maxRuns set     → field updated           kills if(false) + !==→=== at line 226
 *   SH21: update with no maxRuns      → field unchanged         kills if(true)  + !==→=== at line 226
 *   SH22: update with description set → description updated     kills if(false) at line 221
 *   SH23: update with name set        → name updated            kills if(false) at line 220
 *
 * recordRun() guards (lines 263, 266, 270–272):
 *   SH24: maxRuns=0 → run once → status stays 'active'         kills `>` → `>=` at line 272
 *          (>= mutation: 0 >= 0 = true → completion triggered incorrectly)
 *   SH25: nextRunAt is non-null after recordRun ('* * * * *')   kills OptionalChaining/ConditionalExpression at line 270
 *   SH26: nextRunAt changes after recordRun (not same as before recalculation) kills MethodExpression at line 270
 *   SH27: history cap at MAX_HISTORY=20 — 21st run truncates    kills BlockStatement/ConditionalExpression at line 266
 *   SH28: recordRun for unknown id returns without throwing      kills `if(!s) return` BlockStatement at line 263
 *
 * parseCron step regex (line 93):
 *   SH29: parseCron('* /5 * * * *') valid=true    kills Regex "never matches" variant at line 93
 *   SH30: plain integer field NOT treated as step  kills Regex "always matches" variant at line 93
 *         '5 * * * *' valid, plain-int path; '61 * * * *' invalid (out-of-bounds)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getScheduleStore,
  resetScheduleStore,
  parseCron,
  nextCronTime,
} from '../src/store/schedules.js';

const BASE_CRON = '* * * * *';
const MAX_HISTORY = 20;

beforeEach(() => {
  resetScheduleStore();
});

// ── update() notifyEmail guard (SH16–SH17) ───────────────────────────────────

describe('ScheduleStore.update() — notifyEmail conditional guard (line 222)', () => {
  // SH16: kills if(false) and `!==` → `===` at line 222
  // if(false): assignment never runs → notifyEmail stays null
  // `===` mutant: `notifyEmail === undefined` = false for 'notify@test.com' → skips assignment
  it('SH16: update with notifyEmail set applies the new value', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'sched', cron: BASE_CRON, text: 'x' }, 'k1');
    expect(s.notifyEmail).toBeUndefined();

    const updated = store.update(s.id, { notifyEmail: 'notify@test.com' });
    expect(updated?.notifyEmail).toBe('notify@test.com');
  });

  // SH17: kills if(true) and `!==` → `===` at line 222
  // if(true): undefined is assigned → notifyEmail becomes undefined
  // `===` mutant: `notifyEmail === undefined` = true for omitted field → assigns it → changes value
  it('SH17: update without notifyEmail leaves notifyEmail unchanged', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'sched', cron: BASE_CRON, text: 'x' }, 'k1');
    store.update(s.id, { notifyEmail: 'original@test.com' });

    const updated = store.update(s.id, { name: 'new-name' }); // no notifyEmail in patch
    expect(updated?.notifyEmail).toBe('original@test.com');
  });
});

// ── update() webhookUrl guard (SH18–SH19) ────────────────────────────────────

describe('ScheduleStore.update() — webhookUrl conditional guard (line 223)', () => {
  // SH18: kills if(false) and `!==` → `===` at line 223
  it('SH18: update with webhookUrl set applies the new value', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'sched', cron: BASE_CRON, text: 'x' }, 'k1');
    expect(s.webhookUrl).toBeUndefined();

    const updated = store.update(s.id, { webhookUrl: 'https://hooks.test.com/notify' });
    expect(updated?.webhookUrl).toBe('https://hooks.test.com/notify');
  });

  // SH19: kills if(true) and `!==` → `===` at line 223
  it('SH19: update without webhookUrl leaves webhookUrl unchanged', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'sched', cron: BASE_CRON, text: 'x' }, 'k1');
    store.update(s.id, { webhookUrl: 'https://original.test.com' });

    const updated = store.update(s.id, { name: 'new-name' });
    expect(updated?.webhookUrl).toBe('https://original.test.com');
  });
});

// ── update() maxRuns guard (SH20–SH21) ───────────────────────────────────────

describe('ScheduleStore.update() — maxRuns conditional guard (line 226)', () => {
  // SH20: kills if(false) and `!==` → `===` at line 226
  it('SH20: update with maxRuns set applies the new value', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'sched', cron: BASE_CRON, text: 'x', maxRuns: 0 }, 'k1');
    expect(s.maxRuns).toBe(0);

    const updated = store.update(s.id, { maxRuns: 10 });
    expect(updated?.maxRuns).toBe(10);
  });

  // SH21: kills if(true) and `!==` → `===` at line 226
  it('SH21: update without maxRuns leaves maxRuns unchanged', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'sched', cron: BASE_CRON, text: 'x', maxRuns: 5 }, 'k1');

    const updated = store.update(s.id, { name: 'new-name' });
    expect(updated?.maxRuns).toBe(5);
  });
});

// ── update() description guard (SH22) ────────────────────────────────────────

describe('ScheduleStore.update() — description conditional guard (line 221)', () => {
  // SH22: kills if(false) at line 221
  it('SH22: update with description set applies the new description', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'sched', cron: BASE_CRON, text: 'x' }, 'k1');

    const updated = store.update(s.id, { description: 'Monitor AI compliance output daily' });
    expect(updated?.description).toBe('Monitor AI compliance output daily');
  });
});

// ── update() name guard (SH23) ───────────────────────────────────────────────

describe('ScheduleStore.update() — name conditional guard (line 220)', () => {
  // SH23: kills if(false) at line 220
  // (if(true) already killed by prior tests that test name update preserves other fields)
  it('SH23: update with name set changes the name', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'original-name', cron: BASE_CRON, text: 'x' }, 'k1');

    const updated = store.update(s.id, { name: 'updated-name' });
    expect(updated?.name).toBe('updated-name');
  });
});

// ── recordRun() maxRuns=0 guard (SH24) ───────────────────────────────────────

describe('ScheduleStore.recordRun() — maxRuns=0 guard at line 272', () => {
  // SH24: kills `>` → `>=` at line 272
  // `>=` mutation: `0 >= 0` = true → maxRuns=0 schedule completes after 1 run
  // Correct (`>` 0): `0 > 0` = false → maxRuns=0 means unlimited → status stays 'active'
  it('SH24: maxRuns=0 (unlimited) — status stays active after one run', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'unlimited', cron: BASE_CRON, text: 'x', maxRuns: 0 }, 'k1');
    expect(s.maxRuns).toBe(0);

    store.recordRun(s.id, {
      ranAt: new Date().toISOString(),
      durationMs: 100,
      overallRisk: 'low',
      claimCount: 1,
      provider: 'mock',
      inputSource: 'text',
      inputSize: 1,
    });

    const updated = store.get(s.id);
    expect(updated?.status).toBe('active');
  });
});

// ── recordRun() nextRunAt update (SH25–SH26) ─────────────────────────────────

describe('ScheduleStore.recordRun() — nextRunAt recalculation at line 270', () => {
  // SH25: kills OptionalChaining/ConditionalExpression on `?.toISOString() ?? null`
  // With '* * * * *' cron, nextCronTime always returns a valid Date → nextRunAt is non-null
  it('SH25: nextRunAt is non-null after recordRun for a wildcard cron', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'sched', cron: BASE_CRON, text: 'x' }, 'k1');

    store.recordRun(s.id, {
      ranAt: new Date().toISOString(),
      durationMs: 50,
      overallRisk: 'low',
      claimCount: 0,
      provider: 'mock',
      inputSource: 'text',
      inputSize: 5,
    });

    const updated = store.get(s.id);
    expect(updated?.nextRunAt).not.toBeNull();
    expect(typeof updated?.nextRunAt).toBe('string');
  });

  // SH26: kills MethodExpression mutation on `.toISOString()` → `.toString()` at line 270
  // ISO strings are exactly 24 chars ('2026-03-21T10:00:00.000Z'); toString() gives locale format
  it('SH26: nextRunAt after recordRun is a valid ISO 8601 date string', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'sched', cron: BASE_CRON, text: 'x' }, 'k1');

    store.recordRun(s.id, {
      ranAt: new Date().toISOString(),
      durationMs: 50,
      overallRisk: 'low',
      claimCount: 0,
      provider: 'mock',
      inputSource: 'text',
      inputSize: 5,
    });

    const updated = store.get(s.id);
    // ISO 8601 format: 'YYYY-MM-DDTHH:mm:ss.sssZ'
    expect(updated?.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ── recordRun() history cap (SH27) ───────────────────────────────────────────

describe('ScheduleStore.recordRun() — history cap at MAX_HISTORY=20 (line 266)', () => {
  // SH27: kills BlockStatement/ConditionalExpression mutation on history truncation
  // Without truncation: history grows unbounded; after 21 runs it has 21 entries
  it('SH27: history length stays at MAX_HISTORY after more than 20 runs', () => {
    const store = getScheduleStore();
    const s = store.create({ name: 'sched', cron: BASE_CRON, text: 'x' }, 'k1');

    for (let i = 0; i < MAX_HISTORY + 1; i++) {
      store.recordRun(s.id, {
        ranAt: new Date().toISOString(),
        durationMs: i,
        overallRisk: 'low',
        claimCount: i,
        provider: 'mock',
        inputSource: 'text',
        inputSize: 1,
      });
    }

    const updated = store.get(s.id);
    expect(updated?.history.length).toBe(MAX_HISTORY);
  });
});

// ── recordRun() unknown id (SH28) ────────────────────────────────────────────

describe('ScheduleStore.recordRun() — unknown id guard (line 263)', () => {
  // SH28: kills BlockStatement removal on `if (!s) return` at line 263
  // Without return: would throw on s.history.unshift() since s is undefined
  it('SH28: recordRun for a non-existent schedule id does not throw', () => {
    const store = getScheduleStore();
    expect(() =>
      store.recordRun('non-existent-id', {
        ranAt: new Date().toISOString(),
        durationMs: 0,
        overallRisk: 'unknown',
        claimCount: 0,
        provider: 'mock',
        inputSource: 'text',
        inputSize: 0,
      })
    ).not.toThrow();
  });
});

// ── parseCron step regex (SH29–SH30) ─────────────────────────────────────────

describe('parseCron — step regex /^\\*\\/\\d+$/ (line 93)', () => {
  // SH29: kills Regex "never matches" variant (e.g. /^$/) at line 93
  // If step regex never matches, '*/5' is treated as unrecognised → returns invalid
  it('SH29: step-style cron */5 is valid', () => {
    const result = parseCron('*/5 * * * *');
    expect(result.valid).toBe(true);
  });

  // SH30: kills Regex "always matches" variant at line 93
  // If step regex always matches, plain integers like '5' enter the step path
  // and `parseInt('5'.slice(2), 10)` = parseInt('', 10) = NaN → step < 1 is false
  // → parseCron('5 * * * *') would return valid:true via wrong path, no bounds check
  // The correct path: '5' does NOT match step regex → goes to comma/range/value branch
  // → parseInt('5', 10) = 5 → 0 <= 5 <= 59 → valid
  // We verify the result is valid (both paths produce valid here), AND that
  // a plain integer out of range is still caught (not swallowed by step path):
  it('SH30: non-step integer field is bounds-checked, not treated as a step', () => {
    // '60 * * * *' — minute=60 is out of bounds [0–59]
    // If regex always matches: '60' → step path → parseInt('0', 10) = 0 → step < 1 → INVALID (coincidentally correct but wrong path)
    // If regex correctly does NOT match '60': → value path → 60 > 59 → INVALID
    // Distinguishing test: use '61 * * * *' — step path: parseInt('1',10)=1 → valid (WRONG!)
    // Correct path: value 61 > 59 → invalid
    const result = parseCron('61 * * * *');
    expect(result.valid).toBe(false);
    // The error must mention bounds, not step
    expect(result.error).toMatch(/out of bounds/i);
  });
});
