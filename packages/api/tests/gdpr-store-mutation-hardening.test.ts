/**
 * N-126 — GDPR store mutation hardening (NH1–NH15)
 *
 * Targets surviving mutants from the stryker-gdpr baseline (60.07% overall):
 *
 * costs.ts (62.77% → target 75%+):
 *   - line 38: `inputText.length / 4` arithmetic (/ vs *)
 *   - line 39: `inputTokens * 2` arithmetic (* vs +/-)
 *   - line 43-45: `/ 1000` vs `* 1000` in cost formula
 *   - line 55: `entry.date < filter.from` boundary (< vs <=)
 *   - line 56: `entry.date > filter.to` boundary (> vs >=)
 *   - lines 77-90: `+=` vs `-=` in getAggregate accumulators
 *
 * notifications.ts (67.30% → target 78%+):
 *   - line 158: `.filter(p => p.events.includes(eventType))` — broadcast event-type filter
 *   - line 162: `targets.length === 0` — hasFallback condition
 *   - line 171: `!pref.events.includes(eventType)` — targeted dispatch guard
 *
 * schedules.ts (56.15% → target 68%+):
 *   - recordRun: runCount++, maxRuns completion, history cap
 *   - parseCron: out-of-bounds range (a > b), step boundary
 *
 * Tests NH1–NH15.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getCostStore, resetCostStore } from '../src/store/costs.js';
import {
  getNotificationStore,
  resetNotificationStore,
} from '../src/store/notifications.js';
import {
  getScheduleStore,
  resetScheduleStore,
  parseCron,
} from '../src/store/schedules.js';

// ── costs.ts token arithmetic (NH1–NH2) ──────────────────────────────────────

describe('CostStore.record — token arithmetic', () => {
  beforeEach(() => resetCostStore());

  // NH1: 4-char text → ceil(4/4)=1 input token, 2 output, total=3
  // Kills: `/ 4` → `* 4`, `/ 3`, `+ 4` mutations on inputTokens calculation
  it('NH1: 4-char input yields estimatedTokens = 3', () => {
    getCostStore().record('k1', 'mock', 'abcd');
    const [entry] = getCostStore().getCosts();
    // inputTokens = ceil(4/4)=1, outputTokens = 1*2=2, total = 3
    expect(entry.estimatedTokens).toBe(3);
  });

  // NH2: 12-char text → ceil(12/4)=3 input tokens, 6 output, total=9
  // Kills: `* 2` → `* 1`, `* 3`, `+ 2`, `- 2` on outputTokens calculation
  it('NH2: 12-char input yields estimatedTokens = 9', () => {
    getCostStore().record('k1', 'mock', 'abcdefghijkl');
    const [entry] = getCostStore().getCosts();
    // inputTokens = ceil(12/4)=3, outputTokens = 3*2=6, total = 9
    expect(entry.estimatedTokens).toBe(9);
  });
});

// ── costs.ts cost formula (NH3) ───────────────────────────────────────────────

describe('CostStore.record — cost formula', () => {
  beforeEach(() => resetCostStore());

  // NH3: openai 4000-char text → exact cost via known rates
  // inputTokens = ceil(4000/4)=1000, outputTokens=2000
  // cost = (1000/1000)*0.005 + (2000/1000)*0.015 = 0.005+0.030 = 0.035
  // Kills: `/ 1000` → `* 1000` (would give enormous value); correct formula required
  it('NH3: openai 4000-char input yields estimatedCostUsd ≈ 0.035', () => {
    getCostStore().record('k1', 'openai', 'x'.repeat(4000));
    const [entry] = getCostStore().getCosts();
    expect(entry.estimatedCostUsd).toBeCloseTo(0.035, 6);
    // With `* 1000` mutant: cost = (1000*1000)*0.005 + (2000*1000)*0.015 = 35,000
    expect(entry.estimatedCostUsd).toBeLessThan(1);
  });
});

// ── costs.ts date filter (NH4–NH5) ────────────────────────────────────────────

describe('CostStore.getCosts — date range filter', () => {
  beforeEach(() => {
    resetCostStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // NH4: from filter excludes entries strictly before the from date
  // Kills: `entry.date < filter.from` → `<=` (boundary flip)
  it('NH4: getCosts({ from }) includes on-boundary date but excludes prior date', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    getCostStore().record('k1', 'mock', 'entry one');

    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    getCostStore().record('k1', 'mock', 'entry two');

    const result = getCostStore().getCosts({ from: '2026-01-02' });
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-01-02');
  });

  // NH5: to filter excludes entries strictly after the to date
  // Kills: `entry.date > filter.to` → `>=` (boundary flip)
  it('NH5: getCosts({ to }) includes on-boundary date but excludes later date', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    getCostStore().record('k1', 'mock', 'entry one');

    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    getCostStore().record('k1', 'mock', 'entry two');

    const result = getCostStore().getCosts({ to: '2026-01-01' });
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-01-01');
  });
});

// ── costs.ts getAggregate accumulators (NH6–NH7) ──────────────────────────────

describe('CostStore.getAggregate — accumulation', () => {
  beforeEach(() => resetCostStore());

  // NH6: totalTokens accumulates (+=), not subtracts (-=)
  it('NH6: aggregate totalTokens equals sum of two entries', () => {
    getCostStore().record('k1', 'mock', 'abcdefgh');   // 8 chars → 6 tokens
    getCostStore().record('k1', 'mock', 'abcdefghijkl'); // 12 chars → 9 tokens
    const agg = getCostStore().getAggregate();
    expect(agg.totalTokens).toBe(15); // 6+9
    // With `-=` mutant: totalTokens = 0 - 6 - 9 = -15
    expect(agg.totalTokens).toBeGreaterThan(0);
  });

  // NH7: byProvider accumulates tokens correctly
  // Kills: `byProvider[provider].tokens +=` → `-=`
  it('NH7: byProvider.mock.tokens equals sum of all mock entries', () => {
    getCostStore().record('k1', 'mock', 'abcd');    // 4 chars → 3 tokens
    getCostStore().record('k1', 'mock', 'abcdefgh'); // 8 chars → 6 tokens
    const agg = getCostStore().getAggregate();
    expect(agg.byProvider['mock'].tokens).toBe(9); // 3+6
    expect(agg.byProvider['mock'].tokens).toBeGreaterThan(0);
  });
});

// ── notifications.ts broadcast event-type filter (NH8) ───────────────────────

describe('NotificationStore.dispatch — broadcast event-type filter', () => {
  beforeEach(() => resetNotificationStore());

  // NH8: broadcast dispatch only targets prefs subscribed to the dispatched eventType
  // Kills: removing `.filter(p => p.events.includes(eventType))` on line 158
  // (mutant would deliver to all prefs regardless of subscribed events)
  it('NH8: broadcast dispatch fires only for prefs subscribed to that eventType', async () => {
    const store = getNotificationStore();
    // key-A subscribes to 'scan.failed' only
    store.setPrefs('key-A', ['scan.failed'], null, null);
    // key-B subscribes to 'weekly.summary' only
    store.setPrefs('key-B', ['weekly.summary'], null, null);

    // Broadcast 'scan.failed' — only key-A should receive it
    await store.dispatch('scan.failed', { error: 'test', provider: 'mock' });

    const history = store.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].keyId).toBe('key-A');
    // With mutant (no filter): both key-A and key-B would be in history
  });
});

// ── notifications.ts targeted dispatch eventType guard (NH9) ─────────────────

describe('NotificationStore.dispatch — targeted dispatch eventType guard', () => {
  beforeEach(() => resetNotificationStore());

  // NH9: when targetKeyId is given, line 171 guard prevents delivery if pref
  // doesn't include the eventType
  // Kills: removing `if (!pref.events.includes(eventType)) continue;` on line 171
  it('NH9: targeted dispatch skips delivery if pref not subscribed to eventType', async () => {
    const store = getNotificationStore();
    // key-C subscribes to 'weekly.summary' but NOT 'scan.failed'
    store.setPrefs('key-C', ['weekly.summary'], null, null);

    // Target dispatch 'scan.failed' to key-C explicitly
    await store.dispatch('scan.failed', { error: 'oops' }, 'key-C');

    const history = store.getHistory();
    // key-C is not subscribed → no delivery recorded
    expect(history).toHaveLength(0);
    // With mutant (guard removed): 1 history entry for key-C
  });
});

// ── notifications.ts hasFallback condition (NH10–NH11) ───────────────────────

describe('NotificationStore.dispatch — global webhook fallback', () => {
  beforeEach(() => {
    resetNotificationStore();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FAULTLINE_NOTIFY_WEBHOOK;
  });

  // NH10: global webhook does NOT fire when matching prefs already exist
  // (targets.length > 0 → hasFallback = false)
  // Kills: removing `targets.length === 0` from hasFallback condition
  it('NH10: global webhook is not used when matching pref exists', async () => {
    process.env.FAULTLINE_NOTIFY_WEBHOOK = 'http://global.example.com/hook';
    const store = getNotificationStore();
    store.setPrefs('key-D', ['scan.failed'], 'http://key-d.example.com/hook', null);

    await store.dispatch('scan.failed', { error: 'e' });

    const history = store.getHistory();
    expect(history).toHaveLength(1);
    // Must be delivered via key-D's pref, NOT the global '*' fallback
    expect(history[0].keyId).toBe('key-D');
    expect(history[0].keyId).not.toBe('*');
  });

  // NH11: global webhook fires when no matching prefs exist
  // (!targetKeyId && !!globalWebhook && targets.length === 0 → hasFallback = true)
  // Confirms the positive path of hasFallback
  it('NH11: global webhook fires when no pref subscribed to eventType', async () => {
    process.env.FAULTLINE_NOTIFY_WEBHOOK = 'http://global.example.com/hook';
    const store = getNotificationStore();
    // key-E subscribes to 'weekly.summary', NOT 'scan.failed'
    store.setPrefs('key-E', ['weekly.summary'], null, null);

    await store.dispatch('scan.failed', { error: 'e' });

    const history = store.getHistory();
    expect(history).toHaveLength(1);
    // Delivered via global fallback — keyId is '*'
    expect(history[0].keyId).toBe('*');
  });
});

// ── notifications.ts deletePrefsForKeys count (NH12) ─────────────────────────

describe('NotificationStore.deletePrefsForKeys', () => {
  beforeEach(() => resetNotificationStore());

  // NH12: deletePrefsForKeys returns accurate count (not 0 or fixed value)
  it('NH12: deletePrefsForKeys returns count of actually deleted prefs', () => {
    const store = getNotificationStore();
    store.setPrefs('key-F', ['scan.failed'], null, null);
    store.setPrefs('key-G', ['weekly.summary'], null, null);
    // key-H has no prefs → delete should not count it

    const count = store.deletePrefsForKeys(['key-F', 'key-G', 'key-H']);
    expect(count).toBe(2); // only F and G had prefs
    expect(store.listPrefs()).toHaveLength(0);
  });
});

// ── schedules.ts parseCron boundary (NH13) ────────────────────────────────────

describe('parseCron — boundary validation', () => {
  // NH13: inverted range (a > b) is rejected
  // Kills: `a > b` → `a < b` or `a >= b`
  it('NH13: parseCron rejects inverted range (5-3 in minute field)', () => {
    const r = parseCron('5-3 * * * *');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('out of bounds');
  });
});

// ── schedules.ts recordRun — runCount and completion (NH14–NH15) ──────────────

describe('ScheduleStore.recordRun', () => {
  const CRON = '0 9 * * 1';

  beforeEach(() => resetScheduleStore());

  // NH14: recordRun increments runCount by exactly 1
  // Kills: `s.runCount++` → no-op or decrement
  it('NH14: recordRun increments runCount from 0 to 1', () => {
    const sched = getScheduleStore().create(
      { name: 'Test', cron: CRON, text: 'some text' },
      'key-run',
    );
    expect(sched.runCount).toBe(0);
    getScheduleStore().recordRun(sched.id, {
      ranAt: new Date().toISOString(),
      durationMs: 100,
      overallRisk: 'low',
      claimCount: 1,
      provider: 'mock',
      inputSource: 'text',
      inputSize: 9,
    });
    expect(getScheduleStore().get(sched.id)!.runCount).toBe(1);
  });

  // NH15: recordRun sets status to 'completed' when maxRuns reached
  // Kills: `s.runCount >= s.maxRuns` → `>` or `<=`
  it('NH15: recordRun marks schedule completed on the maxRuns-th run', () => {
    const sched = getScheduleStore().create(
      { name: 'Capped', cron: CRON, text: 'some text', maxRuns: 2 },
      'key-cap',
    );
    const runPayload = {
      ranAt: new Date().toISOString(),
      durationMs: 50,
      overallRisk: 'low',
      claimCount: 0,
      provider: 'mock' as const,
      inputSource: 'text' as const,
      inputSize: 9,
    };
    getScheduleStore().recordRun(sched.id, runPayload); // run 1/2 → still active
    expect(getScheduleStore().get(sched.id)!.status).toBe('active');

    getScheduleStore().recordRun(sched.id, runPayload); // run 2/2 → completed
    expect(getScheduleStore().get(sched.id)!.status).toBe('completed');
    expect(getScheduleStore().get(sched.id)!.runCount).toBe(2);
  });
});
