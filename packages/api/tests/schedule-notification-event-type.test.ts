/**
 * N-131 — dispatchScheduleNotification event-type correctness fix (SC1–SC15)
 *
 * Bug: dispatchScheduleNotification always dispatched 'scan.failed' regardless
 * of whether the scan succeeded or failed. Error runs also had no dispatch at all.
 *
 * Fix:
 *   - 'scan.completed' added to NotificationEventType + ALL_EVENT_TYPES + EVENT_CATALOGUE
 *   - dispatchScheduleNotification uses runResult.error to choose 'scan.failed' vs 'scan.completed'
 *   - catch block in runSchedule() now also calls dispatchScheduleNotification
 *
 * Test plan:
 *   SC1:  'scan.completed' is in ALL_EVENT_TYPES
 *   SC2:  'scan.completed' is in EVENT_CATALOGUE
 *   SC3:  EVENT_CATALOGUE['scan.completed'].description is non-empty
 *   SC4:  EVENT_CATALOGUE['scan.completed'].example has scheduleId, overallRisk, claimCount
 *   SC5:  'scan.failed' is still in ALL_EVENT_TYPES (no regression)
 *   SC6:  successful runSchedule() dispatches 'scan.completed' notification
 *   SC7:  successful runSchedule() does NOT dispatch 'scan.failed'
 *   SC8:  failed runSchedule() dispatches 'scan.failed' notification
 *   SC9:  failed runSchedule() does NOT dispatch 'scan.completed'
 *   SC10: 'scan.completed' payload has scheduleId, overallRisk, claimCount
 *   SC11: 'scan.failed' payload has error field from thrown exception
 *   SC12: 'scan.completed' payload overallRisk matches scan result
 *   SC13: 'scan.completed' payload claimCount matches scan result
 *   SC14: key subscribed to 'scan.completed' is notified on success (not on failure)
 *   SC15: key subscribed to 'scan.failed' is notified on error (not on success)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getScheduleStore,
  getScheduleRunner,
  resetScheduleStore,
  resetScheduleRunner,
} from '../src/store/schedules.js';
import {
  ALL_EVENT_TYPES,
  EVENT_CATALOGUE,
  getNotificationStore,
  resetNotificationStore,
} from '../src/store/notifications.js';

// ── Mock scan ──────────────────────────────────────────────────────────────────

const { mockScan } = vi.hoisted(() => ({ mockScan: vi.fn() }));

vi.mock('@nxtg/faultline/cli/scan.js', () => ({
  scan: mockScan,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSchedule() {
  resetScheduleStore();
  resetNotificationStore();
  const store = getScheduleStore();
  const s = store.create({
    name:     'test-schedule',
    cron:     '* * * * *',
    text:     'AI claims text',
    provider: 'mock',
  }, 'key-sc');
  // Subscribe key to both event types so dispatch can find a prefs entry
  getNotificationStore().setPrefs('key-sc', ['scan.completed', 'scan.failed'], null, null);
  return s;
}

// ── Catalogue tests (SC1–SC5) ─────────────────────────────────────────────────

describe('NotificationEventType catalogue — scan.completed', () => {
  it('SC1: scan.completed is in ALL_EVENT_TYPES', () => {
    expect(ALL_EVENT_TYPES).toContain('scan.completed');
  });

  it('SC2: scan.completed has an entry in EVENT_CATALOGUE', () => {
    expect(EVENT_CATALOGUE).toHaveProperty('scan.completed');
  });

  it('SC3: EVENT_CATALOGUE[scan.completed].description is non-empty', () => {
    expect(EVENT_CATALOGUE['scan.completed'].description.length).toBeGreaterThan(0);
  });

  it('SC4: EVENT_CATALOGUE[scan.completed].example has expected fields', () => {
    const { example } = EVENT_CATALOGUE['scan.completed'];
    expect(example).toHaveProperty('scheduleId');
    expect(example).toHaveProperty('overallRisk');
    expect(example).toHaveProperty('claimCount');
  });

  it('SC5: scan.failed is still in ALL_EVENT_TYPES (no regression)', () => {
    expect(ALL_EVENT_TYPES).toContain('scan.failed');
  });
});

// ── runSchedule event routing (SC6–SC9) ───────────────────────────────────────

describe('ScheduleRunner.runSchedule() — event type routing', () => {
  beforeEach(() => {
    resetScheduleStore();
    resetNotificationStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetScheduleRunner();
  });

  // SC6: success → scan.completed dispatched
  it('SC6: successful scan dispatches scan.completed notification', async () => {
    mockScan.mockResolvedValue({ overallRisk: 'low', claims: [{ id: '1' }, { id: '2' }] });
    const s = makeSchedule();
    getScheduleRunner();
    await getScheduleRunner().runSchedule(s);

    const history = getNotificationStore().getHistory('key-sc');
    const rec = history.find(r => r.eventType === 'scan.completed');
    expect(rec!.eventType).toBe('scan.completed');
  });

  // SC7: success → scan.failed NOT dispatched
  it('SC7: successful scan does not dispatch scan.failed', async () => {
    mockScan.mockResolvedValue({ overallRisk: 'low', claims: [] });
    const s = makeSchedule();
    await getScheduleRunner().runSchedule(s);

    const history = getNotificationStore().getHistory('key-sc');
    const failRec = history.find(r => r.eventType === 'scan.failed');
    expect(failRec).toBeUndefined();
  });

  // SC8: error → scan.failed dispatched
  it('SC8: failed scan dispatches scan.failed notification', async () => {
    mockScan.mockRejectedValue(new Error('provider timeout'));
    const s = makeSchedule();
    await getScheduleRunner().runSchedule(s);

    const history = getNotificationStore().getHistory('key-sc');
    const rec = history.find(r => r.eventType === 'scan.failed');
    expect(rec!.eventType).toBe('scan.failed');
  });

  // SC9: error → scan.completed NOT dispatched
  it('SC9: failed scan does not dispatch scan.completed', async () => {
    mockScan.mockRejectedValue(new Error('provider timeout'));
    const s = makeSchedule();
    await getScheduleRunner().runSchedule(s);

    const history = getNotificationStore().getHistory('key-sc');
    const completedRec = history.find(r => r.eventType === 'scan.completed');
    expect(completedRec).toBeUndefined();
  });
});

// ── Payload content (SC10–SC13) ───────────────────────────────────────────────

describe('dispatchScheduleNotification — payload field content', () => {
  beforeEach(() => {
    resetScheduleStore();
    resetNotificationStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetScheduleRunner();
  });

  // SC10: scan.completed payload has scheduleId, overallRisk, claimCount
  it('SC10: scan.completed payload has scheduleId, overallRisk, claimCount', async () => {
    mockScan.mockResolvedValue({ overallRisk: 'medium', claims: [{ id: '1' }, { id: '2' }, { id: '3' }] });
    const s = makeSchedule();
    await getScheduleRunner().runSchedule(s);

    const history = getNotificationStore().getHistory('key-sc');
    const rec = history.find(r => r.eventType === 'scan.completed')!;
    expect(rec.payload.scheduleId).toBe(s.id);
    expect(rec.payload.overallRisk).toBeDefined();
    expect(typeof rec.payload.claimCount).toBe('number');
  });

  // SC11: scan.failed payload has error field from the thrown exception message
  it('SC11: scan.failed payload contains error field from thrown exception', async () => {
    mockScan.mockRejectedValue(new Error('network timeout'));
    const s = makeSchedule();
    await getScheduleRunner().runSchedule(s);

    const history = getNotificationStore().getHistory('key-sc');
    const rec = history.find(r => r.eventType === 'scan.failed')!;
    expect(rec).toBeDefined();
    expect(rec.payload.error).toBe('network timeout');
  });

  // SC12: scan.completed payload overallRisk matches the scan result
  it('SC12: scan.completed payload overallRisk matches scan result', async () => {
    mockScan.mockResolvedValue({ overallRisk: 'high', claims: [] });
    const s = makeSchedule();
    await getScheduleRunner().runSchedule(s);

    const history = getNotificationStore().getHistory('key-sc');
    const rec = history.find(r => r.eventType === 'scan.completed')!;
    expect(rec.payload.overallRisk).toBe('high');
  });

  // SC13: scan.completed payload claimCount matches number of claims in result
  it('SC13: scan.completed payload claimCount matches number of claims returned', async () => {
    mockScan.mockResolvedValue({ overallRisk: 'low', claims: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] });
    const s = makeSchedule();
    await getScheduleRunner().runSchedule(s);

    const history = getNotificationStore().getHistory('key-sc');
    const rec = history.find(r => r.eventType === 'scan.completed')!;
    expect(rec.payload.claimCount).toBe(4);
  });
});

// ── Subscription filtering (SC14–SC15) ────────────────────────────────────────

describe('Notification subscription filtering — event type isolation', () => {
  beforeEach(() => {
    resetScheduleStore();
    resetNotificationStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetScheduleRunner();
  });

  // SC14: key subscribed to scan.completed receives on success, not on error
  it('SC14: key subscribed only to scan.completed receives notification on success, not on error', async () => {
    resetScheduleStore();
    resetNotificationStore();
    const store = getScheduleStore();
    const s = store.create({ name: 'sub-test', cron: '* * * * *', text: 'text', provider: 'mock' }, 'key-completed');
    // Subscribe only to scan.completed (not scan.failed)
    getNotificationStore().setPrefs('key-completed', ['scan.completed'], null, null);

    mockScan.mockResolvedValue({ overallRisk: 'low', claims: [] });
    await getScheduleRunner().runSchedule(s);

    const history = getNotificationStore().getHistory('key-completed');
    expect(history.length).toBe(1);
    expect(history[0].eventType).toBe('scan.completed');
  });

  // SC15: key subscribed to scan.failed receives notification on error, not on success
  it('SC15: key subscribed only to scan.failed receives notification on error, not on success', async () => {
    resetScheduleStore();
    resetNotificationStore();
    const store = getScheduleStore();
    const s = store.create({ name: 'fail-sub', cron: '* * * * *', text: 'text', provider: 'mock' }, 'key-failed');
    // Subscribe only to scan.failed (not scan.completed)
    getNotificationStore().setPrefs('key-failed', ['scan.failed'], null, null);

    mockScan.mockRejectedValue(new Error('all providers down'));
    await getScheduleRunner().runSchedule(s);

    const history = getNotificationStore().getHistory('key-failed');
    expect(history.length).toBe(1);
    expect(history[0].eventType).toBe('scan.failed');
    expect(history[0].payload.error).toBe('all providers down');
  });
});
