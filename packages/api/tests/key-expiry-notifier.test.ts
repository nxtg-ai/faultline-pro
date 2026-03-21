/**
 * N-88 — Key expiry notifications (key.expiring_soon)
 *
 * KEN1–KEN10  KeyExpiryNotifier unit: threshold logic, dedup, payload shape,
 *              skip conditions (no expiry, already expired, disabled).
 *              Uses vi.spyOn on NotificationStore.dispatch to observe calls
 *              without needing webhook prefs configured.
 * KEN11–KEN15 NotificationStore integration: history records written when prefs
 *              are configured (setPrefs(['key.expiring_soon'])).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KeyExpiryNotifier, resetKeyExpiryNotifier, getKeyExpiryNotifier } from '../src/store/key-expiry-notifier.js';
import { getKeyStore, resetKeyStore } from '../src/store/keys.js';
import { getNotificationStore, resetNotificationStore, ALL_EVENT_TYPES } from '../src/store/notifications.js';

/** ISO datetime N milliseconds from now */
function inMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** ISO datetime N milliseconds in the past */
function agoMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

const DAY_MS = 24 * 3_600_000;

// ── Unit tests (spy on dispatch) ─────────────────────────────────────────────

describe('KeyExpiryNotifier — unit', () => {
  let notifier: KeyExpiryNotifier;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dispatchSpy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    resetKeyStore();
    resetNotificationStore();
    notifier = new KeyExpiryNotifier();
    dispatchSpy = vi.spyOn(getNotificationStore(), 'dispatch').mockResolvedValue(undefined);
  });

  it('KEN1: key with no expiresAt — no dispatch', () => {
    getKeyStore().create('Permanent Key');
    notifier.check();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('KEN2: key expiring in 10 days — no dispatch (above 7d threshold)', () => {
    getKeyStore().create('Far Key', ['scan'], inMs(10 * DAY_MS));
    notifier.check();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('KEN3: key expiring in 5 days — 7d dispatch', () => {
    getKeyStore().create('Soon Key', ['scan'], inMs(5 * DAY_MS));
    notifier.check();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      'key.expiring_soon',
      expect.objectContaining({ threshold: '7d' }),
      expect.any(String),
    );
  });

  it('KEN4: key expiring in 12 hours — both 7d and 1d dispatched', () => {
    getKeyStore().create('Urgent Key', ['scan'], inMs(12 * 3_600_000));
    notifier.check();
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    const thresholds = dispatchSpy.mock.calls.map(c => (c[1] as { threshold: string }).threshold).sort();
    expect(thresholds).toEqual(['1d', '7d']);
  });

  it('KEN5: second check() does not re-dispatch — deduplication', () => {
    getKeyStore().create('Soon Key', ['scan'], inMs(5 * DAY_MS));
    notifier.check();
    notifier.check();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('KEN6: already-expired key — no dispatch', () => {
    getKeyStore().create('Expired Key', ['scan'], agoMs(1000));
    notifier.check();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('KEN7: disabled key — no dispatch', () => {
    const entry = getKeyStore().create('Disabled Key', ['scan'], inMs(3 * DAY_MS));
    getKeyStore().disable(entry.id);
    notifier.check();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('KEN8: dispatch payload includes keyId, keyName, expiresAt, hoursRemaining, threshold', () => {
    const expiresAt = inMs(5 * DAY_MS);
    const entry = getKeyStore().create('Payload Key', ['scan'], expiresAt);
    notifier.check();
    expect(dispatchSpy).toHaveBeenCalledWith(
      'key.expiring_soon',
      expect.objectContaining({
        keyId:          entry.id,
        keyName:        'Payload Key',
        expiresAt,
        threshold:      '7d',
        hoursRemaining: expect.any(Number),
      }),
      entry.id,
    );
  });

  it('KEN9: reset() clears dedup — re-dispatch allowed', () => {
    getKeyStore().create('Reset Key', ['scan'], inMs(5 * DAY_MS));
    notifier.check();
    notifier.reset();
    notifier.check();
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
  });

  it('KEN10: multiple keys — each dispatches independently', () => {
    getKeyStore().create('Key A', ['scan'], inMs(3 * DAY_MS));  // 3d → only 7d threshold
    getKeyStore().create('Key B', ['scan'], inMs(5 * DAY_MS));  // 5d → only 7d threshold
    getKeyStore().create('Key C');                               // no expiry → skipped
    notifier.check();
    expect(dispatchSpy).toHaveBeenCalledTimes(2); // one 7d each for A and B
  });
});

// ── NotificationStore integration (with prefs configured) ────────────────────

describe('key.expiring_soon — NotificationStore integration', () => {
  let notifier: KeyExpiryNotifier;

  beforeEach(() => {
    resetKeyStore();
    resetNotificationStore();
    resetKeyExpiryNotifier();
    notifier = new KeyExpiryNotifier();
  });

  it('KEN11: key.expiring_soon is in ALL_EVENT_TYPES', () => {
    expect(ALL_EVENT_TYPES).toContain('key.expiring_soon');
  });

  it('KEN12: notification record written to history when prefs subscribed', async () => {
    const entry = getKeyStore().create('Key', ['scan'], inMs(2 * DAY_MS));
    getNotificationStore().setPrefs(entry.id, ['key.expiring_soon'], null, null);
    notifier.check();
    await new Promise(r => setTimeout(r, 10));
    const records = getNotificationStore().getHistory();
    expect(records).toHaveLength(1);
    expect(records[0].eventType).toBe('key.expiring_soon');
  });

  it('KEN13: hoursRemaining in history record is a non-negative integer', async () => {
    const entry = getKeyStore().create('Key', ['scan'], inMs(5 * DAY_MS));
    getNotificationStore().setPrefs(entry.id, ['key.expiring_soon'], null, null);
    notifier.check();
    await new Promise(r => setTimeout(r, 10));
    const record = getNotificationStore().getHistory()[0];
    expect(Number.isInteger(record.payload.hoursRemaining)).toBe(true);
    expect(record.payload.hoursRemaining as number).toBeGreaterThan(0);
  });

  it('KEN14: singleton deduplicates across calls — one history record after two checks', async () => {
    const entry = getKeyStore().create('Key', ['scan'], inMs(5 * DAY_MS));
    getNotificationStore().setPrefs(entry.id, ['key.expiring_soon'], null, null);
    getKeyExpiryNotifier().check();
    await new Promise(r => setTimeout(r, 10));
    getKeyExpiryNotifier().check();
    await new Promise(r => setTimeout(r, 10));
    expect(getNotificationStore().getHistory()).toHaveLength(1);
  });

  it('KEN15: 20-hour key triggers both 7d and 1d records in history', async () => {
    const entry = getKeyStore().create('Almost-gone Key', ['scan'], inMs(20 * 3_600_000));
    getNotificationStore().setPrefs(entry.id, ['key.expiring_soon'], null, null);
    notifier.check();
    await new Promise(r => setTimeout(r, 10));
    const thresholds = getNotificationStore().getHistory().map(h => h.payload.threshold as string);
    expect(thresholds).toContain('7d');
    expect(thresholds).toContain('1d');
  });
});
