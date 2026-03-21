/**
 * Notification Hardening Tests (N-149) — NH1–NH15
 *
 * Validates: N-88 (Key expiry notifications), N-102 (Key rotation notifications),
 *            N-22 (Monitoring/Observability)
 *
 * Covers uncovered branches across four notification modules:
 *   NH1–NH3  : store/notifications.ts — reset() method body (lines 220-221),
 *              notifyWeeklySummary() for loop body (lines 252-253)
 *   NH4–NH5  : routes/notifications.ts — GET /notifications/prefs admin list (line 62)
 *   NH6–NH9  : key-expiry-notifier.ts — .catch(() => undefined) callbacks
 *              (lines 51, 72), singleton getKeyExpiryNotifier / resetKeyExpiryNotifier
 *   NH10–NH15: key-rotation-notifier.ts — .catch(() => undefined) callbacks
 *              (lines 52, 73), singleton getKeyRotationNotifier /
 *              resetKeyRotationNotifier (lines 88-93)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  getNotificationStore,
  resetNotificationStore,
  notifyWeeklySummary,
} from '../src/store/notifications.js';
import {
  KeyExpiryNotifier,
  getKeyExpiryNotifier,
  resetKeyExpiryNotifier,
} from '../src/store/key-expiry-notifier.js';
import {
  KeyRotationNotifier,
  getKeyRotationNotifier,
  resetKeyRotationNotifier,
} from '../src/store/key-rotation-notifier.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import type { FastifyInstance } from 'fastify';

const DAY_MS = 24 * 3_600_000;

function agoMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function inMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// ===========================================================================
// NH1–NH3 — store/notifications.ts uncovered branches
// ===========================================================================

describe('NotificationStore.reset() — lines 220-221', () => {
  beforeEach(() => resetNotificationStore());

  it('NH1: reset() clears prefs map', async () => {
    const store = getNotificationStore();
    store.setPrefs('k1', ['scan.failed'], null, null);
    expect(store.listPrefs()).toHaveLength(1);

    store.reset();

    expect(store.listPrefs()).toHaveLength(0);
  });

  it('NH2: reset() clears history array', async () => {
    const store = getNotificationStore();
    store.setPrefs('k1', ['scan.failed'], null, null);
    await store.dispatch('scan.failed', { error: 'test' }, 'k1');
    expect(store.getHistory('k1', 10)).toHaveLength(1);

    store.reset();

    expect(store.getHistory(undefined, 100)).toHaveLength(0);
  });

  it('NH3: reset() on empty store is safe (no-throw)', () => {
    const store = getNotificationStore();
    expect(() => store.reset()).not.toThrow();
    expect(store.listPrefs()).toHaveLength(0);
    expect(store.getHistory()).toHaveLength(0);
  });
});

describe('notifyWeeklySummary() — lines 252-253', () => {
  beforeEach(() => resetNotificationStore());

  it('NH4: empty summaries array → no dispatches', async () => {
    const spy = vi.spyOn(getNotificationStore(), 'dispatch');
    await notifyWeeklySummary([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('NH5: single summary entry → dispatches weekly.summary for that keyId', async () => {
    getNotificationStore().setPrefs('k1', ['weekly.summary'], null, null);
    await notifyWeeklySummary([{ keyId: 'k1', scanCount: 10, errorCount: 1, topProvider: 'gemini' }]);
    const history = getNotificationStore().getHistory('k1', 1);
    expect(history).toHaveLength(1);
    expect(history[0]!.eventType).toBe('weekly.summary');
  });

  it('NH6: two summary entries → dispatches once for each keyId (covers loop body twice)', async () => {
    getNotificationStore().setPrefs('k1', ['weekly.summary'], null, null);
    getNotificationStore().setPrefs('k2', ['weekly.summary'], null, null);
    await notifyWeeklySummary([
      { keyId: 'k1', scanCount: 5, errorCount: 0, topProvider: 'gemini' },
      { keyId: 'k2', scanCount: 3, errorCount: 2, topProvider: 'mock' },
    ]);
    expect(getNotificationStore().getHistory('k1', 1)).toHaveLength(1);
    expect(getNotificationStore().getHistory('k2', 1)).toHaveLength(1);
  });
});

// ===========================================================================
// NH7–NH8 — routes/notifications.ts GET /notifications/prefs (line 62)
// ===========================================================================

describe('GET /notifications/prefs — admin list (line 62)', () => {
  let server: FastifyInstance;

  beforeEach(() => {
    resetNotificationStore();
    process.env.FAULTLINE_API_KEY = 'admin-key';
    server = buildServer();
  });

  afterEach(async () => {
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
  });

  it('NH7: returns 200 with empty prefs list when no prefs configured', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/notifications/prefs',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.prefs).toEqual([]);
    expect(Array.isArray(body.eventTypes)).toBe(true);
  });

  it('NH8: returns 200 with populated prefs list', async () => {
    getNotificationStore().setPrefs('k1', ['scan.failed'], 'https://hook.example.com', null);
    getNotificationStore().setPrefs('k2', ['weekly.summary'], null, null);

    const res = await server.inject({
      method: 'GET',
      url: '/notifications/prefs',
      headers: { 'x-api-key': 'admin-key' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.prefs).toHaveLength(2);
    expect(body.prefs.some((p: { keyId: string }) => p.keyId === 'k1')).toBe(true);
  });
});

// ===========================================================================
// NH9–NH11 — key-expiry-notifier.ts .catch callbacks + singleton fns
// ===========================================================================

describe('KeyExpiryNotifier — .catch callbacks + singletons', () => {
  beforeEach(() => {
    resetKeyStore();
    resetNotificationStore();
    resetKeyExpiryNotifier();
  });

  it('NH9: dispatch rejection is swallowed — catch callback runs (lines 51, 72)', async () => {
    // Key expiring in 6h — triggers both 7d and 1d thresholds
    const k = getKeyStore().create('Expiring Key', ['scan'], inMs(6 * 3_600_000));
    const notifier = new KeyExpiryNotifier();

    // Make dispatch reject — tests that .catch(() => undefined) handles it
    vi.spyOn(getNotificationStore(), 'dispatch').mockRejectedValue(new Error('delivery failed'));

    // Should not throw despite dispatch rejecting
    expect(() => notifier.check()).not.toThrow();

    // Flush microtasks so .catch callbacks execute
    await new Promise(resolve => setTimeout(resolve, 0));
    // No assertion on side effect — coverage records catch callback execution
  });

  it('NH10: getKeyExpiryNotifier() returns singleton — same instance on second call', () => {
    const a = getKeyExpiryNotifier();
    const b = getKeyExpiryNotifier();
    expect(a).toBe(b);
  });

  it('NH11: resetKeyExpiryNotifier() creates a fresh instance', () => {
    const before = getKeyExpiryNotifier();
    resetKeyExpiryNotifier();
    const after = getKeyExpiryNotifier();
    expect(after).not.toBe(before);
  });
});

// ===========================================================================
// NH12–NH15 — key-rotation-notifier.ts .catch callbacks + singleton fns
// ===========================================================================

describe('KeyRotationNotifier — .catch callbacks + singletons (lines 52, 73, 88-93)', () => {
  beforeEach(() => {
    resetKeyStore();
    resetNotificationStore();
    resetKeyRotationNotifier();
  });

  it('NH12: dispatch rejection swallowed — catch callback runs (lines 52, 73)', async () => {
    // Key created 200 days ago — triggers both 90d and 180d thresholds
    const k = getKeyStore().create('Old Key', ['scan']);
    const list = getKeyStore().list();
    const entry = list.find(e => e.id === k.id)!;
    (entry as { createdAt: string }).createdAt = agoMs(200 * DAY_MS);

    const notifier = new KeyRotationNotifier();
    vi.spyOn(getNotificationStore(), 'dispatch').mockRejectedValue(new Error('webhook down'));

    expect(() => notifier.check()).not.toThrow();

    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('NH13: getKeyRotationNotifier() returns singleton (line 87-89)', () => {
    const a = getKeyRotationNotifier();
    const b = getKeyRotationNotifier();
    expect(a).toBe(b);
  });

  it('NH14: resetKeyRotationNotifier() creates fresh instance (lines 92-93)', () => {
    const before = getKeyRotationNotifier();
    resetKeyRotationNotifier();
    const after = getKeyRotationNotifier();
    expect(after).not.toBe(before);
  });

  it('NH15: getKeyRotationNotifier() then check() works on a fresh instance', () => {
    const notifier = getKeyRotationNotifier();
    // No keys → check() is a no-op
    expect(() => notifier.check()).not.toThrow();
  });
});
