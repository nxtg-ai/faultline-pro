/**
 * N-102 — Key rotation reminder notifications (key.rotation_due)
 *
 * KRN1–KRN10  KeyRotationNotifier unit: threshold logic, dedup, payload shape,
 *              skip conditions (disabled, expired, fresh key).
 *              Uses vi.spyOn on NotificationStore.dispatch to observe calls
 *              without needing webhook prefs configured.
 * KRN11–KRN15 Catalogue + integration: key.rotation_due in ALL_EVENT_TYPES,
 *              EVENT_CATALOGUE, and NotificationStore history.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KeyRotationNotifier } from '../src/store/key-rotation-notifier.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import {
  getNotificationStore,
  resetNotificationStore,
  ALL_EVENT_TYPES,
  EVENT_CATALOGUE,
} from '../src/store/notifications.js';

const DAY_MS = 24 * 3_600_000;

function agoMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function inMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// ── Unit tests (spy on dispatch) ─────────────────────────────────────────────

describe('KeyRotationNotifier — unit', () => {
  let notifier: KeyRotationNotifier;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dispatchSpy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    resetKeyStore();
    resetNotificationStore();
    notifier = new KeyRotationNotifier();
    dispatchSpy = vi.spyOn(getNotificationStore(), 'dispatch').mockResolvedValue(undefined);
  });

  it('KRN1: fresh key (created today) — no dispatch', () => {
    getKeyStore().create('Fresh Key');
    notifier.check();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('KRN2: key 60 days old — below 90d threshold, no dispatch', () => {
    const k = getKeyStore().create('Moderate Key');
    // Manually backdate createdAt via store (workaround: create then patch timestamp)
    const list = getKeyStore().list();
    const entry = list.find(e => e.id === k.id)!;
    (entry as { createdAt: string }).createdAt = agoMs(60 * DAY_MS);
    notifier.check();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('KRN3: key 95 days old (createdAt) — fires 90d dispatch', () => {
    const k = getKeyStore().create('Old Key');
    const entry = getKeyStore().list().find(e => e.id === k.id)!;
    (entry as { createdAt: string }).createdAt = agoMs(95 * DAY_MS);
    notifier.check();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      'key.rotation_due',
      expect.objectContaining({ keyId: k.id, threshold: '90d' }),
      k.id,
    );
  });

  it('KRN4: key 185 days old — fires both 90d and 180d dispatches', () => {
    const k = getKeyStore().create('Very Old Key');
    const entry = getKeyStore().list().find(e => e.id === k.id)!;
    (entry as { createdAt: string }).createdAt = agoMs(185 * DAY_MS);
    notifier.check();
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const thresholds = dispatchSpy.mock.calls.map((c: unknown[]) => (c[1] as { threshold: string }).threshold);
    expect(thresholds).toContain('90d');
    expect(thresholds).toContain('180d');
  });

  it('KRN5: deduplication — second check does not re-fire', () => {
    const k = getKeyStore().create('Dup Key');
    const entry = getKeyStore().list().find(e => e.id === k.id)!;
    (entry as { createdAt: string }).createdAt = agoMs(95 * DAY_MS);
    notifier.check();
    notifier.check();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('KRN6: reset() clears dedup state — re-fires after reset', () => {
    const k = getKeyStore().create('Reset Key');
    const entry = getKeyStore().list().find(e => e.id === k.id)!;
    (entry as { createdAt: string }).createdAt = agoMs(95 * DAY_MS);
    notifier.check();
    notifier.reset();
    notifier.check();
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
  });

  it('KRN7: disabled key — skipped entirely', () => {
    const k = getKeyStore().create('Disabled Key');
    getKeyStore().disable(k.id);
    const entry = getKeyStore().list().find(e => e.id === k.id)!;
    (entry as { createdAt: string }).createdAt = agoMs(95 * DAY_MS);
    notifier.check();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('KRN8: expired key — skipped', () => {
    const k = getKeyStore().create('Expired Key', ['scan'], inMs(-1)); // already expired
    const entry = getKeyStore().list().find(e => e.id === k.id)!;
    (entry as { createdAt: string }).createdAt = agoMs(95 * DAY_MS);
    notifier.check();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('KRN9: payload contains keyId, keyName, daysSinceRotation, threshold', () => {
    const k = getKeyStore().create('Payload Check');
    const entry = getKeyStore().list().find(e => e.id === k.id)!;
    (entry as { createdAt: string }).createdAt = agoMs(95 * DAY_MS);
    notifier.check();
    const payload = dispatchSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.keyId).toBe(k.id);
    expect(payload.keyName).toBe('Payload Check');
    expect(typeof payload.daysSinceRotation).toBe('number');
    expect(payload.daysSinceRotation).toBeGreaterThanOrEqual(95);
    expect(payload.threshold).toBe('90d');
  });

  it('KRN10: uses lastRotatedAt over createdAt when present', () => {
    const k = getKeyStore().create('Rotated Key');
    const entry = getKeyStore().list().find(e => e.id === k.id)!;
    // createdAt is 200 days ago but lastRotatedAt is 30 days ago — should NOT fire
    (entry as { createdAt: string }).createdAt         = agoMs(200 * DAY_MS);
    (entry as { lastRotatedAt: string }).lastRotatedAt = agoMs(30  * DAY_MS);
    notifier.check();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

// ── Catalogue + integration tests ────────────────────────────────────────────

describe('key.rotation_due — catalogue and integration', () => {
  beforeEach(() => {
    resetKeyStore();
    resetNotificationStore();
  });

  it('KRN11: key.rotation_due is in ALL_EVENT_TYPES', () => {
    expect(ALL_EVENT_TYPES).toContain('key.rotation_due');
  });

  it('KRN12: key.rotation_due has an entry in EVENT_CATALOGUE', () => {
    expect(EVENT_CATALOGUE['key.rotation_due']).toBeDefined();
    expect(typeof EVENT_CATALOGUE['key.rotation_due'].description).toBe('string');
  });

  it('KRN13: EVENT_CATALOGUE entry has example with daysSinceRotation and threshold', () => {
    const ex = EVENT_CATALOGUE['key.rotation_due'].example;
    expect(typeof ex.daysSinceRotation).toBe('number');
    expect(typeof ex.threshold).toBe('string');
  });

  it('KRN14: NotificationStore records history when prefs include key.rotation_due', async () => {
    const k = getKeyStore().create('Prefs Key');
    const entry = getKeyStore().list().find(e => e.id === k.id)!;
    (entry as { createdAt: string }).createdAt = new Date(Date.now() - 95 * DAY_MS).toISOString();

    getNotificationStore().setPrefs(k.id, ['key.rotation_due'], null, null);

    const notifier = new KeyRotationNotifier();
    notifier.check();

    // Allow microtasks to settle (dispatch is async but fire-and-forget)
    await new Promise(r => setTimeout(r, 10));

    const history = getNotificationStore().getHistory(k.id);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].eventType).toBe('key.rotation_due');
  });

  it('KRN15: GET /notifications/events includes key.rotation_due', async () => {
    const { buildServer } = await import('../src/server.js');
    const server = buildServer();
    process.env.FAULTLINE_API_KEY = 'test-key-rn15';
    getKeyStore().create('RN15 Key');
    const res = await server.inject({ method: 'GET', url: '/notifications/events', headers: { 'x-api-key': 'test-key-rn15' } });
    await server.close();
    delete process.env.FAULTLINE_API_KEY;
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('key.rotation_due');
  });
});
