/**
 * KeyExpiryNotifier — dispatches key.expiring_soon notifications.
 *
 * Called on the server's 1-minute tick. Checks all keys for upcoming expiry
 * and fires at two thresholds: 7 days and 1 day. Each threshold fires at most
 * once per key per server lifetime (deduplication via in-memory Set).
 *
 * Skips: keys with no expiresAt, already-expired keys, disabled keys.
 */

import { getKeyStore } from './keys.js';
import { getNotificationStore } from './notifications.js';

const THRESHOLD_7D_MS = 7 * 24 * 3_600_000;
const THRESHOLD_1D_MS = 1 * 24 * 3_600_000;

export class KeyExpiryNotifier {
  /** Tracks which (keyId, threshold) pairs have already been dispatched. */
  private fired: Set<string> = new Set();

  check(): void {
    const now = Date.now();
    const store = getKeyStore();

    for (const entry of store.list()) {
      if (!entry.expiresAt) continue;
      if (entry.disabled) continue;

      const expiresMs = new Date(entry.expiresAt).getTime();
      if (expiresMs <= now) continue; // already expired

      const remaining = expiresMs - now;

      // 7-day threshold
      if (remaining <= THRESHOLD_7D_MS) {
        const key7d = `${entry.id}:7d`;
        if (!this.fired.has(key7d)) {
          this.fired.add(key7d);
          void getNotificationStore()
            .dispatch(
              'key.expiring_soon',
              {
                keyId:          entry.id,
                keyName:        entry.name,
                expiresAt:      entry.expiresAt,
                hoursRemaining: Math.floor(remaining / 3_600_000),
                threshold:      '7d',
              },
              entry.id,
            )
            .catch(() => undefined);
        }
      }

      // 1-day threshold
      if (remaining <= THRESHOLD_1D_MS) {
        const key1d = `${entry.id}:1d`;
        if (!this.fired.has(key1d)) {
          this.fired.add(key1d);
          void getNotificationStore()
            .dispatch(
              'key.expiring_soon',
              {
                keyId:          entry.id,
                keyName:        entry.name,
                expiresAt:      entry.expiresAt,
                hoursRemaining: Math.floor(remaining / 3_600_000),
                threshold:      '1d',
              },
              entry.id,
            )
            .catch(() => undefined);
        }
      }
    }
  }

  /** Clear dedup state — used in tests to simulate a fresh server. */
  reset(): void {
    this.fired.clear();
  }
}

let instance: KeyExpiryNotifier | null = null;

export function getKeyExpiryNotifier(): KeyExpiryNotifier {
  if (!instance) instance = new KeyExpiryNotifier();
  return instance;
}

export function resetKeyExpiryNotifier(): void {
  instance = new KeyExpiryNotifier();
}
